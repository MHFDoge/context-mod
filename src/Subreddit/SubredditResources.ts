import {RedditUser, Comment, Submission} from "snoowrap";
import cache from 'memory-cache';
import objectHash from 'object-hash';
import {
    AuthorActivitiesOptions,
    AuthorTypedActivitiesOptions,
    getAuthorActivities,
    testAuthorCriteria
} from "../Utils/SnoowrapUtils";
import Subreddit from 'snoowrap/dist/objects/Subreddit';
import winston, {Logger} from "winston";
import {mergeArr} from "../util";
import LoggedError from "../Utils/LoggedError";
import {SubredditCacheConfig} from "../Common/interfaces";
import {AuthorCriteria} from "../Rule";
import UserNotes from "./UserNotes";

export const WIKI_DESCRIM = 'wiki:';

export interface SubredditCacheOptions extends SubredditCacheConfig {
    enabled: boolean;
    subreddit: Subreddit,
    logger: Logger;
}

export class SubredditResources {
    enabled: boolean;
    protected authorTTL: number;
    protected useSubredditAuthorCache: boolean;
    protected wikiTTL: number;
    name: string;
    protected logger: Logger;
    userNotes: UserNotes;

    constructor(name: string, options: SubredditCacheOptions) {
        const {
            enabled = true,
            authorTTL,
            subreddit,
            userNotesTTL = 60000,
            wikiTTL = 300000, // 5 minutes
            logger,
        } = options || {};

        this.enabled = manager.enabled ? enabled : false;
        if (authorTTL === undefined) {
            this.useSubredditAuthorCache = false;
            this.authorTTL = manager.authorTTL;
        } else {
            this.useSubredditAuthorCache = true;
            this.authorTTL = authorTTL;
        }
        this.wikiTTL = wikiTTL;

        this.userNotes = new UserNotes(enabled ? userNotesTTL : 0, subreddit, logger);

        this.name = name;
        if (logger === undefined) {
            const alogger = winston.loggers.get('default')
            this.logger = alogger.child({labels: [this.name, 'Resource Cache']}, mergeArr);
        } else {
            this.logger = logger.child({labels: ['Resource Cache']}, mergeArr);
        }
    }

    async getAuthorActivities(user: RedditUser, options: AuthorTypedActivitiesOptions): Promise<Array<Submission | Comment>> {
        const useCache = this.enabled && this.authorTTL > 0;
        let hash;
        if (useCache) {
            const userName = user.name;
            const hashObj: any = {...options, userName};
            if (this.useSubredditAuthorCache) {
                hashObj.subreddit = this.name;
            }
            hash = objectHash.sha1({...options, userName});

            const cacheVal = cache.get(hash);
            if (null !== cacheVal) {
                this.logger.debug(`Cache Hit: ${userName} (${options.type || 'overview'})`);
                return cacheVal as Array<Submission | Comment>;
            }
        }


        const items = await getAuthorActivities(user, options);

        if (useCache) {
            cache.put(hash, items, this.authorTTL);
        }
        return Promise.resolve(items);
    }

    async getAuthorComments(user: RedditUser, options: AuthorActivitiesOptions): Promise<Comment[]> {
        return await this.getAuthorActivities(user, {...options, type: 'comment'}) as unknown as Promise<Comment[]>;
    }

    async getAuthorSubmissions(user: RedditUser, options: AuthorActivitiesOptions): Promise<Submission[]> {
        return await this.getAuthorActivities(user, {
            ...options,
            type: 'submission'
        }) as unknown as Promise<Submission[]>;
    }

    async getContent(val: string, subreddit: Subreddit): Promise<string> {
        const hasWiki = val.trim().substring(0, WIKI_DESCRIM.length) === WIKI_DESCRIM;
        if (!hasWiki) {
            return val;
        } else {
            const useCache = this.enabled && this.wikiTTL > 0;
            const wikiPath = val.trim().substring(WIKI_DESCRIM.length);

            let hash = `${subreddit.display_name}-${wikiPath}`;
            if (useCache) {
                const cachedContent = cache.get(`${subreddit.display_name}-${wikiPath}`);
                if (cachedContent !== null) {
                    this.logger.debug(`Cache Hit: ${wikiPath}`);
                    return cachedContent;
                }
            }

            try {
                const wikiPage = subreddit.getWikiPage(wikiPath);
                const wikiContent = await wikiPage.content_md;

                if (useCache) {
                    cache.put(hash, wikiContent, this.wikiTTL);
                }

                return wikiContent;
            } catch (err) {
                const msg = `Could not read wiki page. Please ensure the page 'https://reddit.com${subreddit.display_name_prefixed}wiki/${wikiPath}' exists and is readable`;
                this.logger.error(msg, err);
                throw new LoggedError(msg);
            }
        }
    }

    async testAuthorCriteria(item: (Comment | Submission), authorOpts: AuthorCriteria, include = true) {
        const useCache = this.enabled && this.authorTTL > 0;
        let hash;
        if (useCache) {
            const hashObj = {itemId: item.id, ...authorOpts, include};
            hash = `authorCrit-${objectHash.sha1(hashObj)}`;
            const cachedAuthorTest = cache.get(hash);
            if (null !== cachedAuthorTest) {
                this.logger.debug(`Cache Hit: Author Check on ${item.id}`);
                return cachedAuthorTest;
            }
        }

        const result = await testAuthorCriteria(item, authorOpts, include, this.userNotes);
        if (useCache) {
            cache.put(hash, result, this.authorTTL);
        }
        return result;
    }
}

class SubredditResourcesManager {
    resources: Map<string, SubredditResources> = new Map();
    authorTTL: number = 10000;
    enabled: boolean = true;

    get(subName: string): SubredditResources | undefined {
        if (this.resources.has(subName)) {
            return this.resources.get(subName) as SubredditResources;
        }
        return undefined;
    }

    set(subName: string, initOptions: SubredditCacheOptions): SubredditResources {
        const resource = new SubredditResources(subName, initOptions);
        this.resources.set(subName, resource);
        return resource;
    }
}

const manager = new SubredditResourcesManager();

export default manager;
