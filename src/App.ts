import Snoowrap from "snoowrap";
import {Manager} from "./Subreddit/Manager";
import winston, {Logger} from "winston";
import {argParseInt, labelledFormat, parseBool, parseFromJsonOrYamlToObject, parseSubredditName, sleep} from "./util";
import snoowrap from "snoowrap";
import pEvent from "p-event";
import EventEmitter from "events";
import CacheManager from './Subreddit/SubredditResources';
import dayjs, {Dayjs} from "dayjs";
import LoggedError from "./Utils/LoggedError";

const {transports} = winston;

const snooLogWrapper = (logger: Logger) => {
    return {
        warn: (...args: any[]) => logger.warn(args.slice(0, 2).join(' '), [args.slice(2)]),
        debug: (...args: any[]) => logger.debug(args.slice(0, 2).join(' '), [args.slice(2)]),
        info: (...args: any[]) => logger.info(args.slice(0, 2).join(' '), [args.slice(2)]),
        trace: (...args: any[]) => logger.debug(args.slice(0, 2).join(' '), [args.slice(2)]),
    }
}

export class App {

    client: Snoowrap;
    subreddits: string[];
    subManagers: Manager[] = [];
    logger: Logger;
    wikiLocation: string;
    dryRun?: true | undefined;
    heartbeatInterval: number;
    apiLimitWarning: number;
    heartBeating: boolean = false;

    constructor(options: any = {}) {
        const {
            subreddits = [],
            clientId,
            clientSecret,
            accessToken,
            refreshToken,
            logDir = process.env.LOG_DIR || `${process.cwd()}/logs`,
            logLevel = process.env.LOG_LEVEL || 'verbose',
            wikiConfig = process.env.WIKI_CONFIG || 'botconfig/contextbot',
            snooDebug = process.env.SNOO_DEBUG || false,
            dryRun = process.env.DRYRUN || false,
            heartbeat = process.env.HEARTBEAT || 300,
            apiLimitWarning = process.env.API_REMAINING || 250,
            version,
            authorTTL = process.env.AUTHOR_TTL || 10000,
            disableCache = process.env.DISABLE_CACHE || false,
        } = options;

        CacheManager.authorTTL = argParseInt(authorTTL);
        CacheManager.enabled = !parseBool(disableCache);

        this.dryRun = parseBool(dryRun) === true ? true : undefined;
        this.heartbeatInterval = argParseInt(heartbeat);
        this.apiLimitWarning = argParseInt(apiLimitWarning);
        this.wikiLocation = wikiConfig;

        const consoleTransport = new transports.Console();

        const myTransports = [
            consoleTransport,
        ];
        let errorTransports = [];

        if (logDir !== false) {
            let logPath = logDir;
            if (logPath === true) {
                logPath = `${process.cwd()}/logs`;
            }
            const rotateTransport = new winston.transports.DailyRotateFile({
                dirname: logPath,
                createSymlink: true,
                symlinkName: 'contextBot-current.log',
                filename: 'contextBot-%DATE%.log',
                datePattern: 'YYYY-MM-DD',
                maxSize: '5m'
            });
            // @ts-ignore
            myTransports.push(rotateTransport);
            errorTransports.push(rotateTransport);
        }

        const loggerOptions = {
            level: logLevel || 'info',
            format: labelledFormat(),
            transports: myTransports,
            levels: {
                error: 0,
                warn: 1,
                info: 2,
                http: 3,
                verbose: 4,
                debug: 5,
                trace: 5,
                silly: 6
            },
            exceptionHandlers: errorTransports,
            rejectionHandlers: errorTransports,
        };

        winston.loggers.add('default', loggerOptions);

        this.logger = winston.loggers.get('default');

        if (this.dryRun) {
            this.logger.info('Running in DRYRUN mode');
        }

        let subredditsArg = [];
        if (subreddits !== undefined) {
            if (Array.isArray(subreddits)) {
                subredditsArg = subreddits;
            } else {
                subredditsArg = subreddits.split(',');
            }
        }
        this.subreddits = subredditsArg.map(parseSubredditName);

        const creds = {
            userAgent: `web:contextBot:${version}`,
            clientId,
            clientSecret,
            refreshToken,
            accessToken,
        };

        this.client = new snoowrap(creds);
        this.client.config({
            warnings: true,
            maxRetryAttempts: 5,
            debug: parseBool(snooDebug),
            logger: snooLogWrapper(this.logger.child({labels: ['Snoowrap']})),
            continueAfterRatelimitError: true,
        });
    }

    async buildManagers(subreddits: string[] = []) {
        let availSubs = [];
        const name = await this.client.getMe().name;
        this.logger.info(`Reddit API Limit Remaining: ${this.client.ratelimitRemaining}`);
        this.logger.info(`Authenticated Account: /u/${name}`);
        for (const sub of await this.client.getModeratedSubreddits()) {
            // TODO don't know a way to check permissions yet
            availSubs.push(sub);
        }
        this.logger.info(`/u/${name} is a moderator of these subreddits: ${availSubs.map(x => x.display_name_prefixed).join(', ')}`);

        let subsToRun = [];
        const subsToUse = subreddits.length > 0 ? subreddits.map(parseSubredditName) : this.subreddits;
        if (subsToUse.length > 0) {
            this.logger.info(`User-defined subreddit constraints detected (CLI argument or environmental variable), will try to run on: ${subsToUse.join(', ')}`);
            for (const sub of subsToUse) {
                const asub = availSubs.find(x => x.display_name.toLowerCase() === sub.toLowerCase())
                if (asub === undefined) {
                    this.logger.warn(`Will not run on ${sub} because is not modded by, or does not have appropriate permissions to mod with, for this client.`);
                } else {
                    // @ts-ignore
                    const fetchedSub = await asub.fetch();
                    subsToRun.push(fetchedSub);
                }
            }
        } else {
            // otherwise assume all moddable subs from client should be run on
            this.logger.info('No user-defined subreddit constraints detected, will try to run on all');
            subsToRun = availSubs;
        }

        let subSchedule: Manager[] = [];
        // get configs for subs we want to run on and build/validate them
        for (const sub of subsToRun) {
            let content = undefined;
            try {
                const wiki = sub.getWikiPage(this.wikiLocation);
                content = await wiki.content_md;
            } catch (err) {
                this.logger.error(`[${sub.display_name_prefixed}] Could not read wiki configuration. Please ensure the page https://reddit.com${sub.url}wiki/${this.wikiLocation} exists and is readable -- error: ${err.message}`);
                continue;
            }

            if(content === '') {
                this.logger.error(`[${sub.display_name_prefixed}] Wiki page contents was empty`);
                continue;
            }

            const [configObj, jsonErr, yamlErr] = parseFromJsonOrYamlToObject(content);

            if (configObj === undefined) {
                this.logger.error(`[${sub.display_name_prefixed}] Could not parse wiki page contents as JSON or YAML:`);
                this.logger.error(jsonErr);
                this.logger.error(yamlErr);
                continue;
            }

            try {
                subSchedule.push(new Manager(sub, this.client, this.logger, configObj, {dryRun: this.dryRun}));
            } catch (err) {
                if(!(err instanceof LoggedError)) {
                    this.logger.error(`[${sub.display_name_prefixed}] Config was not valid`, err);
                }
            }
        }
        this.subManagers = subSchedule;
    }

    async heartbeat() {
        try {
            this.heartBeating = true;
            while (true) {
                await sleep(this.heartbeatInterval * 1000);
                const heartbeat = `HEARTBEAT -- Reddit API Rate Limit remaining: ${this.client.ratelimitRemaining}`
                if (this.apiLimitWarning >= this.client.ratelimitRemaining) {
                    this.logger.warn(heartbeat);
                } else {
                    this.logger.info(heartbeat);
                }
            }
        } finally {
            this.heartBeating = false;
        }
    }

    async runManagers() {

        // basic backoff delay if reddit is under load and not responding
        let timeoutCount = 0;
        let maxTimeoutCount = 4;
        let otherRetryCount = 0;
        // not sure should even allow so set to 0 for now
        let maxOtherCount = 0;
        let keepRunning = true;
        let lastErrorAt: Dayjs | undefined;

        while (keepRunning) {
            try {
                for (const manager of this.subManagers) {
                    if (!manager.running) {
                        manager.handle();
                    }
                }

                if (this.heartbeatInterval !== 0 && !this.heartBeating) {
                    this.heartbeat();
                }

                const emitter = new EventEmitter();
                await pEvent(emitter, 'end');
                keepRunning = false;
            } catch (err) {
                if (lastErrorAt !== undefined && dayjs().diff(lastErrorAt, 'minute') >= 5) {
                    // if its been longer than 5 minutes since last error clear counters
                    timeoutCount = 0;
                    otherRetryCount = 0;
                }

                lastErrorAt = dayjs();

                if (err.message.includes('ETIMEDOUT') || (err.code !== undefined && err.code.includes('ETIMEDOUT'))) {
                    timeoutCount++;
                    if (timeoutCount > maxTimeoutCount) {
                        this.logger.error(`Timeouts (${timeoutCount}) exceeded max allowed (${maxTimeoutCount})`);
                        throw err;
                    }
                    // exponential backoff
                    const ms = (Math.pow(2, timeoutCount - 1) + (Math.random() - 0.3)) * 1000;
                    this.logger.warn(`Reddit response timed out. Will wait ${ms / 1000} seconds before restarting managers`);
                    await sleep(ms);

                } else {
                    // linear backoff
                    otherRetryCount++;
                    if (maxOtherCount > otherRetryCount) {
                        throw err;
                    }
                    const ms = (3 * 1000) * otherRetryCount;
                    this.logger.warn(`Non-timeout error occurred. Will wait ${ms / 1000} seconds before restarting managers`);
                    await sleep(ms);
                }
            }
        }
    }
}
