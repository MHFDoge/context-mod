import winston, {Logger} from "winston";
import {
    asNamedCriteria, asWikiContext,
    buildCachePrefix, buildFilter, castToBool,
    createAjvFactory, fileOrDirectoryIsWriteable,
    mergeArr, mergeFilters,
    normalizeName,
    overwriteMerge,
    parseBool, parseExternalUrl, parseUrlContext, parseWikiContext, randomId,
    readConfigFile,
    removeUndefinedKeys, resolvePathFromEnvWithRelative
} from "./util";

import Ajv, {Schema} from 'ajv';
import * as appSchema from './Schema/App.json';
import * as runSchema from './Schema/Run.json';
import * as checkSchema from './Schema/Check.json';
import * as operatorSchema from './Schema/OperatorConfig.json';
//import * as rulesetSchema from './Schema/RuleSet.json';
import {SubredditConfigHydratedData, SubredditConfigData} from "./SubredditConfigData";
import LoggedError from "./Utils/LoggedError";
import {
    ActivityCheckConfigData,
    ActivityCheckConfigHydratedData,
    CheckConfigHydratedData,
    CheckConfigObject
} from "./Check";
import {
    DEFAULT_POLLING_INTERVAL,
    DEFAULT_POLLING_LIMIT,
    OperatorJsonConfig,
    OperatorConfig,
    PollingOptions,
    PollingOptionsStrong,
    StrongCache,
    CacheOptions,
    BotInstanceJsonConfig,
    BotInstanceConfig,
    RequiredWebRedditCredentials,
    RedditCredentials,
    BotCredentialsJsonConfig,
    BotCredentialsConfig,
    OperatorFileConfig,
    PostBehavior
} from "./Common/interfaces";
import {isRuleSetJSON, RuleSetConfigData, RuleSetConfigHydratedData, RuleSetConfigObject} from "./Rule/RuleSet";
import deepEqual from "fast-deep-equal";
import {isActionJson} from "./Action";
import {getLogger} from "./Utils/loggerFactory";
import {GetEnvVars} from 'env-cmd';
import merge from 'deepmerge';
import * as process from "process";
import {
    cacheOptDefaults,
    cacheTTLDefaults,
    defaultConfigFilenames,
    defaultDataDir,
    filterCriteriaDefault
} from "./Common/defaults";
import objectHash from "object-hash";
import {
    createAppDatabaseConnection,
    createDatabaseConfig,
    createWebDatabaseConnection
} from "./Utils/databaseUtils";
import path from 'path';
import {
    JsonOperatorConfigDocument,
    YamlOperatorConfigDocument
} from "./Common/Config/Operator";
import {Document as YamlDocument} from "yaml";
import {CMError, SimpleError} from "./Utils/Errors";
import {ErrorWithCause} from "pony-cause";
import {RunConfigHydratedData, RunConfigData, RunConfigObject} from "./Run";
import {AuthorRuleConfig} from "./Rule/AuthorRule";
import {
    CacheProvider, ConfigFormat, ConfigFragmentValidationFunc,
    PollOn
} from "./Common/Infrastructure/Atomic";
import {
    FilterCriteriaDefaults,
    FilterCriteriaDefaultsJson,
    MaybeAnonymousOrStringCriteria, MinimalOrFullFilter, MinimalOrFullFilterJson, NamedCriteria
} from "./Common/Infrastructure/Filters/FilterShapes";
import {AuthorCriteria, TypedActivityState} from "./Common/Infrastructure/Filters/FilterCriteria";
import {StrongLoggingOptions} from "./Common/Infrastructure/Logging";
import {DatabaseDriver, DatabaseDriverType} from "./Common/Infrastructure/Database";
import {parseFromJsonOrYamlToObject} from "./Common/Config/ConfigUtil";
import {RunnableBaseJson, StructuredRunnableBase} from "./Common/Infrastructure/Runnable";
import {
    RuleConfigData, RuleConfigHydratedData,
    RuleConfigObject,
} from "./Common/Infrastructure/RuleShapes";
import {
    ActionConfigHydratedData, ActionConfigObject,
} from "./Common/Infrastructure/ActionShapes";
import {SubredditResources} from "./Subreddit/SubredditResources";
import {asIncludesData, IncludesData, IncludesString} from "./Common/Infrastructure/Includes";
import ConfigParseError from "./Utils/ConfigParseError";

export interface ConfigBuilderOptions {
    logger: Logger,
}

export const validateJson = <T>(config: object, schema: Schema, logger: Logger): T => {
    const ajv = createAjvFactory(logger);
    const valid = ajv.validate(schema, config);
    if (valid) {
        return config as unknown as T;
    } else {
        logger.error('Json config was not valid. Please use schema to check validity.', {leaf: 'Config'});
        if (Array.isArray(ajv.errors)) {
            for (const err of ajv.errors) {
                let parts = [
                    `At: ${err.dataPath}`,
                ];
                let data;
                if (typeof err.data === 'string') {
                    data = err.data;
                } else if (err.data !== null && typeof err.data === 'object' && (err.data as any).name !== undefined) {
                    data = `Object named '${(err.data as any).name}'`;
                }
                if (data !== undefined) {
                    parts.push(`Data: ${data}`);
                }
                let suffix = '';
                // @ts-ignore
                if (err.params.allowedValues !== undefined) {
                    // @ts-ignore
                    suffix = err.params.allowedValues.join(', ');
                    suffix = ` [${suffix}]`;
                }
                parts.push(`${err.keyword}: ${err.schemaPath} => ${err.message}${suffix}`);

                // if we have a reference in the description parse it out so we can log it here for context
                if (err.parentSchema !== undefined && err.parentSchema.description !== undefined) {
                    const desc = err.parentSchema.description as string;
                    const seeIndex = desc.indexOf('[See]');
                    if (seeIndex !== -1) {
                        let newLineIndex: number | undefined = desc.indexOf('\n', seeIndex);
                        if (newLineIndex === -1) {
                            newLineIndex = undefined;
                        }
                        const seeFragment = desc.slice(seeIndex + 5, newLineIndex);
                        parts.push(`See:${seeFragment}`);
                    }
                }

                logger.error(`Schema Error:\r\n${parts.join('\r\n')}`, {leaf: 'Config'});
            }
        }
        throw new LoggedError('Config schema validity failure');
    }
}

export class ConfigBuilder {
    configLogger: Logger;
    logger: Logger;

    constructor(options: ConfigBuilderOptions) {

        this.configLogger = options.logger.child({labels: ['Config']}, mergeArr);
        this.logger = options.logger;
    }

    validateJson(config: object): SubredditConfigData {
        return validateJson<SubredditConfigData>(config, appSchema, this.logger);
    }

    async hydrateConfigFragment<T>(val: IncludesData | string | object, resource: SubredditResources, validateFunc?: ConfigFragmentValidationFunc): Promise<T[]> {
        let includes: IncludesData | undefined = undefined;
        if(typeof val === 'string') {
            const strContextResult = parseUrlContext(val);
            if(strContextResult !== undefined) {
                this.configLogger.debug(`Detected ${asWikiContext(strContextResult) !== undefined ? 'REDDIT WIKI' : 'URL'} type Config Fragment from string: ${val}`);
                includes = {
                    path: val as IncludesString
                };
            } else {
                this.configLogger.debug(`Did not detect Config Fragment as a URL resource: ${val}`);
            }
        } else if (asIncludesData(val)) {
            includes = val;
            const strContextResult = parseUrlContext(val.path);
            if(strContextResult === undefined) {
                throw new ConfigParseError(`Could not detect Config Fragment path as a valid URL Resource. Resource must be prefixed with either 'url:' or 'wiki:' -- ${val.path}`);
            }
        }

        if(includes === undefined) {
            if(Array.isArray(val)) {
                return val as unknown as T[];
            } else {
                return [val as unknown as T];
            }
        }

       const resolvedFragment = await resource.getConfigFragment(includes, validateFunc);
        if(Array.isArray(resolvedFragment)) {
            return resolvedFragment
        }
        return [resolvedFragment as T];
    }

    async hydrateConfig(config: SubredditConfigData, resource: SubredditResources): Promise<SubredditConfigHydratedData> {
        const {
            runs = [],
            checks = [],
            ...restConfig
        } = config;

        if(checks.length > 0 && runs.length > 0) {
            // cannot have both checks and runs at top-level
            throw new Error(`Subreddit configuration cannot contain both 'checks' and 'runs' at top-level.`);
        }

        // TODO consolidate this with parseToStructured
        const realRuns  = runs;
        if(checks.length > 0) {
            realRuns.push({name: 'Run1', checks: checks});
        }

        const hydratedRuns: RunConfigHydratedData[] = [];

        let runIndex = 1;
        for(const r of realRuns) {

            let hydratedRunArr: RunConfigData | RunConfigData[];

            try {
                hydratedRunArr = await this.hydrateConfigFragment<RunConfigData>(r, resource, <RunConfigData>(data: object, fetched: boolean) => {
                    if (fetched) {
                        if (Array.isArray(data)) {
                            for (const runData of data) {
                                validateJson<RunConfigData>(runData, runSchema, this.logger);
                            }
                        } else {
                            validateJson<RunConfigData>(data, runSchema, this.logger);
                        }
                        return true;
                    }
                    return true;
                });
            } catch (e: any) {
                throw new CMError(`Could not fetch or validate Run #${runIndex}`, {cause: e});
            }

            for(const hydratedRunVal of hydratedRunArr) {
                if (typeof hydratedRunVal === 'string') {
                    throw new ConfigParseError(`Run Config Fragment #${runIndex} was not in a recognized Config Fragment format. Given: ${hydratedRunVal}`);
                }

                // validate run with unhydrated checks
                const preValidatedRun = hydratedRunVal as RunConfigData;

                const {checks, ...rest} = preValidatedRun;

                const hydratedChecks: CheckConfigHydratedData[] = [];
                let checkIndex = 1;
                for (const c of preValidatedRun.checks) {
                    let hydratedCheckDataArr: ActivityCheckConfigHydratedData[];

                    try {
                        hydratedCheckDataArr = await this.hydrateConfigFragment<ActivityCheckConfigHydratedData>(c, resource, (data: object, fetched: boolean) => {
                            if (fetched) {
                                if (Array.isArray(data)) {
                                    for (const checkObj of data) {
                                        validateJson<ActivityCheckConfigHydratedData>(checkObj, checkSchema, this.logger);
                                    }
                                } else {
                                    validateJson<ActivityCheckConfigHydratedData>(data, checkSchema, this.logger);
                                }
                                return true;
                            }
                            return true;
                        });
                    } catch (e: any) {
                        throw new CMError(`Could not fetch or validate Check Config Fragment #${checkIndex} in Run #${runIndex}`, {cause: e});
                    }

                    for (const hydratedCheckData of hydratedCheckDataArr) {
                        if (typeof hydratedCheckData === 'string') {
                            throw new ConfigParseError(`Check #${checkIndex} in Run #${runIndex} was not in a recognized include format. Given: ${hydratedCheckData}`);
                        }

                        const preValidatedCheck = hydratedCheckData as ActivityCheckConfigHydratedData;

                        const {rules, actions, ...rest} = preValidatedCheck;
                        const hydratedCheckConfigData: CheckConfigHydratedData = rest;

                        if (rules !== undefined) {
                            const hydratedRulesOrSets: (RuleSetConfigHydratedData | RuleConfigHydratedData)[] = [];

                            let ruleIndex = 1;
                            for (const r of rules) {
                                let hydratedRuleOrSetArr: (RuleConfigHydratedData | RuleSetConfigHydratedData)[];
                                try {
                                    hydratedRuleOrSetArr = await this.hydrateConfigFragment<(RuleSetConfigHydratedData | RuleConfigHydratedData)>(r, resource);
                                } catch (e: any) {
                                    throw new CMError(`Rule Config Fragment #${ruleIndex} in Check #${checkIndex} could not be fetched`, {cause: e});
                                }
                                for (const hydratedRuleOrSet of hydratedRuleOrSetArr) {
                                    if (typeof hydratedRuleOrSet === 'string') {
                                        hydratedRulesOrSets.push(hydratedRuleOrSet);
                                    } else if (isRuleSetJSON(hydratedRuleOrSet)) {
                                        const hydratedRulesetRules: RuleConfigHydratedData[] = [];
                                        for (const rsr of hydratedRuleOrSet.rules) {
                                            const hydratedRuleSetRuleArr = await this.hydrateConfigFragment<RuleConfigHydratedData>(rsr, resource);
                                            for(const rsrData of hydratedRuleSetRuleArr) {
                                                // either a string or rule data at this point
                                                // we will validate the whole check again so this rule will be validated eventually
                                                hydratedRulesetRules.push(rsrData)
                                            }
                                        }
                                        hydratedRuleOrSet.rules = hydratedRulesetRules;
                                        hydratedRulesOrSets.push(hydratedRuleOrSet);
                                    } else {
                                        hydratedRulesOrSets.push(hydratedRuleOrSet);
                                    }
                                    ruleIndex++;
                                }
                            }
                            hydratedCheckConfigData.rules = hydratedRulesOrSets;
                        }

                        if (actions !== undefined) {
                            const hydratedActions: ActionConfigHydratedData[] = [];

                            let actionIndex = 1;
                            for (const a of actions) {
                                let hydratedActionArr: ActionConfigHydratedData[];
                                try {
                                    hydratedActionArr = await this.hydrateConfigFragment<ActionConfigHydratedData>(a, resource);
                                } catch (e: any) {
                                    throw new CMError(`Action Config Fragment #${actionIndex} in Check #${checkIndex} could not be fetched`, {cause: e});
                                }
                                for (const hydratedAction of hydratedActionArr) {
                                    hydratedActions.push(hydratedAction);
                                    actionIndex++;
                                }
                            }
                            hydratedCheckConfigData.actions = hydratedActions;
                        }

                        hydratedChecks.push(hydratedCheckConfigData);
                        checkIndex++;
                    }
                }

                const hydratedRun: RunConfigHydratedData = {...rest, checks: hydratedChecks};

                hydratedRuns.push(hydratedRun);
                runIndex++;
            }
        }

        const hydratedConfig: SubredditConfigHydratedData = {...restConfig, runs: hydratedRuns};

        const validatedHydratedConfig = validateJson<SubredditConfigHydratedData>(hydratedConfig, appSchema, this.logger);

        return validatedHydratedConfig;
    }

    async parseToStructured(config: SubredditConfigData, resource: SubredditResources, filterCriteriaDefaultsFromBot?: FilterCriteriaDefaults, postCheckBehaviorDefaultsFromBot: PostBehavior = {}): Promise<RunConfigObject[]> {
        let namedRules: Map<string, RuleConfigObject> = new Map();
        let namedActions: Map<string, ActionConfigObject> = new Map();
        const {filterCriteriaDefaults, postCheckBehaviorDefaults} = config;

        const hydratedConfig = await this.hydrateConfig(config, resource);

        const {runs: realRuns = []} = hydratedConfig;

        for(const r of realRuns) {
            for (const c of r.checks) {
                const {rules = [], actions = []} = c;
                namedRules = extractNamedRules(rules, namedRules);
                namedActions = extractNamedActions(actions, namedActions);
            }
        }

        const [namedAuthorFilters, namedItemFilters] = extractNamedFilters({...hydratedConfig, runs: realRuns});

        const configFilterDefaults = filterCriteriaDefaults === undefined ? undefined : buildDefaultFilterCriteriaFromJson(filterCriteriaDefaults, namedAuthorFilters, namedItemFilters);

        const structuredRuns: RunConfigObject[] = [];

        const namedFilters = insertNameFilters(namedAuthorFilters, namedItemFilters);

        for(const r of realRuns) {

            const {filterCriteriaDefaults: filterCriteriaDefaultsFromRun, postFail, postTrigger, authorIs, itemIs } = r;

            const [derivedRunAuthorIs, derivedRunItemIs] = mergeFilters(namedFilters(r), configFilterDefaults ?? filterCriteriaDefaultsFromBot);

            const configFilterDefaultsFromRun = filterCriteriaDefaultsFromRun === undefined ? undefined : buildDefaultFilterCriteriaFromJson(filterCriteriaDefaultsFromRun, namedAuthorFilters, namedItemFilters);

            const structuredChecks: CheckConfigObject[] = [];
            for (const c of r.checks) {
                const {rules = [], actions = [], authorIs = {}, itemIs = []} = c;
                const strongRules = insertNamedRules(rules, namedRules, namedAuthorFilters, namedItemFilters);
                const strongActions = insertNamedActions(actions, namedActions, namedAuthorFilters, namedItemFilters);

                const [derivedAuthorIs, derivedItemIs] = mergeFilters(namedFilters(c), configFilterDefaultsFromRun ?? (configFilterDefaults ?? filterCriteriaDefaultsFromBot));

                const postCheckBehaviors = Object.assign({}, postCheckBehaviorDefaultsFromBot, removeUndefinedKeys({postFail, postTrigger}));

                const strongCheck = {
                    ...c,
                    authorIs: derivedAuthorIs,
                    itemIs: derivedItemIs,
                    rules: strongRules,
                    actions: strongActions,
                    ...postCheckBehaviors
                } as CheckConfigObject;
                structuredChecks.push(strongCheck);
            }
            structuredRuns.push({
                ...r,
                checks: structuredChecks,
                authorIs: derivedRunAuthorIs,
                itemIs: derivedRunItemIs
            });
        }

        return structuredRuns;
    }
}

export const buildPollingOptions = (values: (string | PollingOptions)[]): PollingOptionsStrong[] => {
    let opts: PollingOptionsStrong[] = [];
    for (const v of values) {
        if (typeof v === 'string') {
            opts.push({
                pollOn: v as PollOn,
                interval: DEFAULT_POLLING_INTERVAL,
                limit: DEFAULT_POLLING_LIMIT,
            });
        } else {
            const {
                pollOn: p,
                interval = DEFAULT_POLLING_INTERVAL,
                limit = DEFAULT_POLLING_LIMIT,
                delayUntil,
            } = v;
            opts.push({
                pollOn: p as PollOn,
                interval,
                limit,
                delayUntil,
            });
        }
    }
    return opts;
}

export const buildDefaultFilterCriteriaFromJson = (val: FilterCriteriaDefaultsJson, namedAuthorFilters: Map<string, NamedCriteria<AuthorCriteria>>, namedItemFilters: Map<string, NamedCriteria<TypedActivityState>>): FilterCriteriaDefaults => {
    const {
        itemIs,
        authorIs,
        ...rest
    } = val;
    const def: FilterCriteriaDefaults = rest;

    const fullFilters = insertNameFilters(namedAuthorFilters, namedItemFilters)(val);
    def.itemIs = fullFilters.itemIs;
    def.authorIs = fullFilters.authorIs;
    return def;
}

export const extractNamedRules = (rules: Array<RuleSetConfigData | RuleConfigData>, namedRules: Map<string, RuleConfigObject> = new Map()): Map<string, RuleConfigObject> => {
    //const namedRules = new Map();
    for (const r of rules) {
        let rulesToAdd: RuleConfigObject[] = [];
        if ((typeof r === 'object')) {
            if ((r as RuleConfigObject).kind !== undefined) {
                // itsa rule
                const rule = r as RuleConfigObject;
                if (rule.name !== undefined) {
                    rulesToAdd.push(rule);
                }
            } else {
                const ruleSet = r as RuleSetConfigData;
                const nestedNamed = extractNamedRules(ruleSet.rules);
                rulesToAdd = [...nestedNamed.values()];
            }
            for (const rule of rulesToAdd) {
                const name = rule.name as string;
                const normalName = normalizeName(name);
                const {name: n, ...rest} = rule;
                const ruleNoName = {...rest};

                if (namedRules.has(normalName)) {
                    const {name: nn, ...ruleRest} = namedRules.get(normalName) as RuleConfigObject;
                    if (!deepEqual(ruleRest, ruleNoName)) {
                        throw new Error(`Rule names must be unique (case-insensitive). Conflicting name: ${name}`);
                    }
                } else {
                    namedRules.set(normalName, rule);
                }
            }
        }
    }
    return namedRules;
}

type FilterJsonFuncArg<T> = (val: MaybeAnonymousOrStringCriteria<T>) => void;

const addToNamedFilter= <T>(namedFilter: Map<string, NamedCriteria<T>>, filterName: string) => (val: MaybeAnonymousOrStringCriteria<T>) => {
    if (typeof val === 'string') {
        return;
    }
    if (asNamedCriteria(val) && val.name !== undefined) {
        if (namedFilter.has(val.name.toLocaleLowerCase())) {
            throw new Error(`names for ${filterName} filters must be unique (case-insensitive). Conflicting name ${val.name}`);
        }
        namedFilter.set(val.name.toLocaleLowerCase(), val);
    }
}

const parseFilterJson = <T>(addToFilter: FilterJsonFuncArg<T>) => (val: MinimalOrFullFilterJson<T> | undefined) => {
    if (val === undefined) {
        return;
    }
    if (Array.isArray(val)) {
        for (const v of val) {
            addToFilter(v);
        }
    } else {
        const {include = [], exclude = []} = val;
        for (const v of include) {
            addToFilter(v);
        }
        for (const v of exclude) {
            addToFilter(v);
        }
    }
}

export const extractNamedFilters = (config: SubredditConfigHydratedData, namedAuthorFilters: Map<string, NamedCriteria<AuthorCriteria>> = new Map(), namedItemFilters: Map<string, NamedCriteria<TypedActivityState>> = new Map()): [Map<string, NamedCriteria<AuthorCriteria>>, Map<string, NamedCriteria<TypedActivityState>>] => {
    const addToAuthors = addToNamedFilter(namedAuthorFilters, 'authorIs');
    const addToItems = addToNamedFilter(namedItemFilters, 'itemIs');

    const parseAuthorIs = parseFilterJson(addToAuthors);
    const parseItemIs = parseFilterJson(addToItems);

    // const parseAuthorIs = (val: MinimalOrFullFilterJson<AuthorCriteria> | undefined) => {
    //     if (val === undefined) {
    //         return;
    //     }
    //     if (Array.isArray(val)) {
    //         for (const v of val) {
    //             addToAuthors(v);
    //         }
    //     } else {
    //         const {include = [], exclude = []} = val;
    //         for (const v of include) {
    //             addToAuthors(v);
    //         }
    //         for (const v of exclude) {
    //             addToAuthors(v);
    //         }
    //     }
    // }

    // const parseItemIs = (val: MinimalOrFullFilterJson<TypedActivityState> | undefined) => {
    //     if (val === undefined) {
    //         return;
    //     }
    //     if (Array.isArray(val)) {
    //         for (const v of val) {
    //             addToItems(v);
    //         }
    //     } else {
    //         const {include = [], exclude = []} = val;
    //         for (const v of include) {
    //             addToItems(v);
    //         }
    //         for (const v of exclude) {
    //             addToItems(v);
    //         }
    //     }
    // }

    //const namedRules = new Map();

    const {
        filterCriteriaDefaults,
        runs = []
    } = config;

    parseAuthorIs(filterCriteriaDefaults?.authorIs);
    parseItemIs(filterCriteriaDefaults?.itemIs);

    for (const r of runs) {

        const {
            filterCriteriaDefaults: filterCriteriaDefaultsFromRun
        } = r;

        parseAuthorIs(filterCriteriaDefaults?.authorIs);
        parseAuthorIs(r.authorIs);
        parseItemIs(r.itemIs);
        parseItemIs(filterCriteriaDefaults?.itemIs);

        for(const c of r.checks) {
             parseAuthorIs(c.authorIs);
             parseItemIs(c.itemIs);

             for(const ru of c.rules ?? []) {
                 if(typeof ru === 'string') {
                     continue;
                 }
                 if(isRuleSetJSON(ru)) {
                     for(const rr of ru.rules) {
                         if(typeof rr === 'string') {
                             continue;
                         }
                         parseAuthorIs(rr.authorIs);
                         parseItemIs(c.itemIs);
                     }
                 } else {
                     parseAuthorIs(ru.authorIs);
                     parseItemIs(c.itemIs);
                 }
             }
             for(const a of c.actions ?? []) {
                 if(typeof a === 'string') {
                     continue;
                 }
                 parseAuthorIs(a.authorIs);
                 parseItemIs(c.itemIs);
             }
        }
    }
    return [namedAuthorFilters, namedItemFilters];
}

const getNamedOrReturn = <T>(namedFilters: Map<string, NamedCriteria<T>>, filterName: string) => (x: MaybeAnonymousOrStringCriteria<T>): NamedCriteria<T> => {
    if(typeof x === 'string') {
        if(!namedFilters.has(x.toLocaleLowerCase())) {
            throw new Error(`No named ${filterName} criteria with the name "${x}"`);
        }
        return namedFilters.get(x) as NamedCriteria<T>;
    }
    if(asNamedCriteria(x)) {
        return x;
    }
    return {criteria: x};
}


export const insertNameFilters = (namedAuthorFilters: Map<string, NamedCriteria<AuthorCriteria>>, namedItemFilters: Map<string, NamedCriteria<TypedActivityState>>) => (val: RunnableBaseJson) => {

    const getNamedAuthorOrReturn = getNamedOrReturn(namedAuthorFilters, 'authorIs');
    const getNamedItemOrReturn = getNamedOrReturn(namedItemFilters, 'itemIs');

    let runnableOpts: StructuredRunnableBase = {
        authorIs: undefined,
        itemIs: undefined,
    }
    if(val.authorIs !== undefined) {
        if (Array.isArray(val.authorIs)) {
            runnableOpts.authorIs = val.authorIs.map(x => getNamedAuthorOrReturn(x))
        } else {
            runnableOpts.authorIs = {};

            const {include, exclude} = val.authorIs;
            if(include !== undefined) {
                runnableOpts.authorIs.include = include.map(x => getNamedAuthorOrReturn(x))
            }
            if(exclude !== undefined) {
                runnableOpts.authorIs.exclude = exclude.map(x => getNamedAuthorOrReturn(x))
            }
        }
    }
    if(val.itemIs !== undefined) {
        if (Array.isArray(val.itemIs)) {
            runnableOpts.itemIs = val.itemIs.map(x => getNamedItemOrReturn(x))
        } else {
            runnableOpts.itemIs = {};

            const {include, exclude} = val.itemIs;
            if(include !== undefined) {
                runnableOpts.itemIs.include = include.map(x => getNamedItemOrReturn(x))
            }
            if(exclude !== undefined) {
                runnableOpts.itemIs.exclude = exclude.map(x => getNamedItemOrReturn(x))
            }
        }
    }

    return runnableOpts;
}

export const insertNamedRules = (rules: Array<RuleSetConfigHydratedData | RuleConfigHydratedData>, namedRules: Map<string, RuleConfigObject> = new Map(), namedAuthorFilters: Map<string, NamedCriteria<AuthorCriteria>> = new Map(), namedItemFilters: Map<string, NamedCriteria<TypedActivityState>> = new Map()): (RuleSetConfigObject | RuleConfigObject)[] => {

    const namedFilters = insertNameFilters(namedAuthorFilters, namedItemFilters);

    const strongRules: (RuleSetConfigObject | RuleConfigObject)[] = [];
    for (const r of rules) {
        let rule: RuleConfigObject | undefined;
        if (typeof r === 'string') {
            const foundRule = namedRules.get(r.toLowerCase());
            if (foundRule === undefined) {
                throw new Error(`No named Rule with the name ${r} was found`);
            }
            rule = {
                ...foundRule,
                ...namedFilters(foundRule)
            } as RuleConfigObject
            //strongRules.push(foundRule);
        } else if (isRuleSetJSON(r)) {
            const {rules: sr, ...rest} = r;
            const setRules = insertNamedRules(sr, namedRules, namedAuthorFilters, namedItemFilters);
            const strongSet = {rules: setRules, ...rest} as RuleSetConfigObject;
            strongRules.push(strongSet);
        } else {
            rule = {...r, ...namedFilters(r)} as RuleConfigObject;
        }

        if(rule !== undefined) {
            if(rule.kind === 'author') {
                const authorRuleConfig = rule as (RuleConfigObject & AuthorRuleConfig);
                const filters = namedFilters({authorIs: {include: authorRuleConfig.include, exclude: authorRuleConfig.exclude}});
                const builtFilter = buildFilter(filters.authorIs as MinimalOrFullFilter<AuthorCriteria>);
                rule = {
                    ...rule,
                    // @ts-ignore
                    include: builtFilter.include,
                    exclude: builtFilter.exclude
                }
            }
            strongRules.push(rule as RuleConfigObject);
        }
    }

    return strongRules;
}

export const extractNamedActions = (actions: Array<ActionConfigHydratedData>, namedActions: Map<string, ActionConfigObject> = new Map()): Map<string, ActionConfigObject> => {
    for (const a of actions) {
        if (!(typeof a === 'string')) {
            if (isActionJson(a) && a.name !== undefined) {
                const normalName = a.name.toLowerCase();
                const {name: n, ...rest} = a;
                const actionNoName = {...rest};
                if (namedActions.has(normalName)) {
                    // @ts-ignore
                    const {name: nn, ...aRest} = namedActions.get(normalName) as ActionConfigObject;
                    if (!deepEqual(aRest, actionNoName)) {
                        throw new Error(`Actions names must be unique (case-insensitive). Conflicting name: ${a.name}`);
                    }
                } else {
                    namedActions.set(normalName, a);
                }
            }
        }
    }
    return namedActions;
}

export const insertNamedActions = (actions: Array<ActionConfigHydratedData>, namedActions: Map<string, ActionConfigObject> = new Map(), namedAuthorFilters: Map<string, NamedCriteria<AuthorCriteria>> = new Map(), namedItemFilters: Map<string, NamedCriteria<TypedActivityState>> = new Map()): Array<ActionConfigObject> => {

    const namedFilters = insertNameFilters(namedAuthorFilters, namedItemFilters);

    const strongActions: Array<ActionConfigObject> = [];
    for (const a of actions) {
        if (typeof a === 'string') {
            const foundAction = namedActions.get(a.toLowerCase());
            if (foundAction === undefined) {
                throw new Error(`No named Action with the name ${a} was found`);
            }
            strongActions.push({...foundAction, ...namedFilters(foundAction)} as ActionConfigObject);
        } else {
            strongActions.push({...a, ...namedFilters(a)} as ActionConfigObject);
        }
    }

    return strongActions;
}

export const parseDefaultBotInstanceFromArgs = (args: any): BotInstanceJsonConfig => {
    const {
        subreddits,
        clientId,
        clientSecret,
        accessToken,
        refreshToken,
        wikiConfig,
        dryRun,
        softLimit,
        heartbeat,
        hardLimit,
        authorTTL,
        sharedMod,
        caching,
    } = args || {};

    const data = {
        credentials: {
            clientId,
            clientSecret,
            accessToken,
            refreshToken,
        },
        subreddits: {
            names: subreddits,
            wikiConfig,
            dryRun,
            heartbeatInterval: heartbeat,
        },
        polling: {
            shared: sharedMod ? ['unmoderated', 'modqueue'] : undefined,
        },
        nanny: {
            softLimit,
            hardLimit
        }
    }
    return removeUndefinedKeys(data) as BotInstanceJsonConfig;
}

export const parseOpConfigFromArgs = (args: any): OperatorJsonConfig => {
    const {
        clientId,
        clientSecret,
        redirectUri,
        operator,
        operatorDisplay,
        logLevel,
        logDir,
        port,
        sessionSecret,
        web,
        mode,
        caching,
        authorTTL,
        snooProxy,
        snooDebug,
    } = args || {};

    const data = {
        mode,
        operator: {
            name: operator,
            display: operatorDisplay
        },
        logging: {
            level: logLevel,
            file: {
                level: logLevel,
                dirName: logDir,
            },
            stream: {
                level: logLevel,
            },
            console: {
                level: logLevel,
            }
        },
        caching: {
            provider: caching,
            authorTTL
        },
        snoowrap: {
            proxy: snooProxy,
            debug: snooDebug,
        },
        web: {
            enabled: web,
            port,
            session: {
                secret: sessionSecret
            },
            credentials: {
                clientId,
                clientSecret,
                redirectUri,
            }
        }
    }

    return removeUndefinedKeys(data) as OperatorJsonConfig;
}

const parseListFromEnv = (val: string | undefined) => {
    let listVals: undefined | string[];
    if (val === undefined) {
        return listVals;
    }
    const trimmedVal = val.trim();
    if (trimmedVal.includes(',')) {
        // try to parse using comma
        listVals = trimmedVal.split(',').map(x => x.trim()).filter(x => x !== '');
    } else {
        // otherwise try spaces
        listVals = trimmedVal.split(' ')
            // remove any extraneous spaces
            .filter(x => x !== ' ' && x !== '');
    }
    if (listVals.length === 0) {
        return undefined;
    }
    return listVals;
}

export const parseDefaultBotInstanceFromEnv = (): BotInstanceJsonConfig => {
    const data = {
        credentials: {
            reddit: {
                clientId: process.env.CLIENT_ID,
                clientSecret: process.env.CLIENT_SECRET,
                accessToken: process.env.ACCESS_TOKEN,
                refreshToken: process.env.REFRESH_TOKEN,
            },
            youtube: process.env.YOUTUBE_API_KEY
        },
        subreddits: {
            names: parseListFromEnv(process.env.SUBREDDITS),
            wikiConfig: process.env.WIKI_CONFIG,
            dryRun: parseBool(process.env.DRYRUN, undefined),
            heartbeatInterval: process.env.HEARTBEAT !== undefined ? parseInt(process.env.HEARTBEAT) : undefined,
        },
        polling: {
            shared: parseBool(process.env.SHARE_MOD) ? ['unmoderated', 'modqueue'] : undefined,
        },
        nanny: {
            softLimit: process.env.SOFT_LIMIT !== undefined ? parseInt(process.env.SOFT_LIMIT) : undefined,
            hardLimit: process.env.HARD_LIMIT !== undefined ? parseInt(process.env.HARD_LIMIT) : undefined
        },
    };
    return removeUndefinedKeys(data) as BotInstanceJsonConfig;
}

export const parseOpConfigFromEnv = (): OperatorJsonConfig => {
    const data = {
        mode: process.env.MODE !== undefined ? process.env.MODE as ('all' | 'server' | 'client') : undefined,
        operator: {
            name: parseListFromEnv(process.env.OPERATOR),
            display: process.env.OPERATOR_DISPLAY
        },
        logging: {
            level: process.env.LOG_LEVEL,
            file: {
                level: process.env.LOG_LEVEL,
                dirname: process.env.LOG_DIR,
            },
            stream: {
                level: process.env.LOG_LEVEL,
            },
            console: {
                level: process.env.LOG_LEVEL,
            }
        },
        caching: {
            provider: {
                // @ts-ignore
                store: process.env.CACHING as (CacheProvider | undefined)
            },
            authorTTL: process.env.AUTHOR_TTL !== undefined ? parseInt(process.env.AUTHOR_TTL) : undefined
        },
        snoowrap: {
            proxy: process.env.PROXY,
            debug: parseBool(process.env.SNOO_DEBUG, undefined),
        },
        web: {
            port: process.env.PORT !== undefined ? parseInt(process.env.PORT) : undefined,
            session: {
                provider: process.env.SESSION_PROVIDER,
                secret: process.env.SESSION_SECRET
            },
            credentials: {
                clientId: process.env.CLIENT_ID,
                clientSecret: process.env.CLIENT_SECRET,
                redirectUri: process.env.REDIRECT_URI,
            },
        },
        credentials: {
            youtube: {
                apiKey: process.env.YOUTUBE_API_KEY
            }
        }
    }

    return removeUndefinedKeys(data) as OperatorJsonConfig;
}

// Hierarchy (lower level overwrites above)
//
// .env file
// Actual ENVs (from environment)
// json config
// args from cli
export const parseOperatorConfigFromSources = async (args: any): Promise<[OperatorJsonConfig, OperatorFileConfig]> => {
    const {
        dataDir = process.env.DATA_DIR ?? defaultDataDir
    } = args || {};
    const envPath = resolvePathFromEnvWithRelative(process.env.OPERATOR_ENV, dataDir, path.resolve(dataDir, './.env'));

    const initLogger = winston.loggers.get('init');

    try {
        const vars = await GetEnvVars({
            envFile: {
                filePath: envPath,
                //fallback: true
            }
        });
        // if we found variables in the file of at a fallback path then add them in before we do main arg parsing
        for (const [k, v] of Object.entries(vars)) {
            // don't override existing
            if (process.env[k] === undefined) {
                process.env[k] = v;
            }
        }
    } catch (err: any) {
        if(err.message.includes('Failed to find .env file at path')) {
            initLogger.warn(`${err.message} -- can be ignored if you didn't include one!`);
        } else {
            throw new ErrorWithCause('Error occurred while parsing .env file that preventing app from starting', {cause: err});
        }
    }

    const {
        operatorConfig: opConfigVal = process.env.OPERATOR_CONFIG
    } = args;
    const resolvedOpConfigVal = resolvePathFromEnvWithRelative(opConfigVal, dataDir);
    //(process.env.OPERATOR_CONFIG ?? path.resolve(__dirname, '../config.yaml'))
    if(resolvedOpConfigVal === undefined) {
        initLogger.debug(`No operator config explicitly specified. Will look for default configs (${defaultConfigFilenames.join(', ')}) at default path (${dataDir})`);
    }
    const opConfigCandidates: string[] = resolvedOpConfigVal !== undefined ? [resolvedOpConfigVal] : defaultConfigFilenames.map(x => path.resolve(dataDir, './', x));

    let configFromFile: OperatorJsonConfig = {};
    let fileConfigFormat: ConfigFormat | undefined = undefined;
    let rawConfig: string = '';
    let configDoc: YamlOperatorConfigDocument | JsonOperatorConfigDocument;
    let writeable = false;
    let operatorConfig;
    for(const opConfigPath of opConfigCandidates) {

        try {
            const [rawConfigValue, format] = await readConfigFile(opConfigPath);
            rawConfig = rawConfigValue ?? '';
            fileConfigFormat = format as ConfigFormat;
            operatorConfig = opConfigPath;
            initLogger.verbose(`Found operator config at ${operatorConfig}`);
            break;
        } catch (err: any) {
            const {code} = err;
            if (code === 'ENOENT' || code === 'EACCES') {
                if(code === 'ENOENT') {
                    initLogger.warn(`No operator config file found at ${opConfigPath}`);
                } else if(code === 'EACCES') {
                    let msg = `Operator config location ${opConfigPath} is not accessible due to permissions.`;
                    if(castToBool(process.env.IS_DOCKER) === true) {
                        msg += `Make sure you have specified user in docker run command! See https://github.com/FoxxMD/context-mod/blob/master/docs/gettingStartedOperator.md#docker-recommended`;
                    }
                    initLogger.warn(msg);
                }

                if (err.extension !== undefined) {
                    fileConfigFormat = err.extension
                }
            } else {
                throw new ErrorWithCause('Cannot continue app startup because operator config file exists but was not parseable.', {cause: err});
            }
        }
    }

    if (operatorConfig === undefined) {
        if (resolvedOpConfigVal !== undefined) {
            // user specified a config location but we could not find it so exit
            throw new Error(`ARG/ENV specified an operator config location but could not find it. Will not continue with app startup.`);
        } else {
            // no user specified config location! may be OK if only using ENVs or blank slate
            // set a default location for op config (will be created here since it does not exist)
            operatorConfig = opConfigCandidates.find(x => x.includes('.yaml'));
            initLogger.verbose(`Defaulting to ${operatorConfig} as operator config location (in the event it needs to be written)`);
        }
    }

    try {
        writeable = fileOrDirectoryIsWriteable(operatorConfig as string);
    } catch (e) {
        let msg = `App does not have permission to WRITE to operator config location. This is only a problem if you plan on adding bots/subreddits via the UI.`;
        if(castToBool(process.env.IS_DOCKER) === true) {
            msg += `Make sure you have specified user in docker run command! See https://github.com/FoxxMD/context-mod/blob/master/docs/gettingStartedOperator.md#docker-recommended`;
        }
        initLogger.warn(msg);
    }

    const [format, doc, jsonErr, yamlErr] = parseFromJsonOrYamlToObject(rawConfig, {
        location: operatorConfig,
        jsonDocFunc: (content, location) => new JsonOperatorConfigDocument(content, location),
        yamlDocFunc: (content, location) => new YamlOperatorConfigDocument(content, location)
    });


    if (format !== undefined && fileConfigFormat === undefined) {
        fileConfigFormat = 'yaml';
    }

    if (doc === undefined && rawConfig !== '') {
        initLogger.error(`Could not parse file contents at ${operatorConfig} as JSON or YAML (likely it is ${fileConfigFormat}):`);
        initLogger.error(jsonErr);
        initLogger.error(yamlErr);
        throw new SimpleError(`Could not parse file contents at ${operatorConfig} as JSON or YAML`);
    } else if (doc === undefined && rawConfig === '') {
        // create an empty doc
        if(fileConfigFormat === 'json') {
            configDoc = new JsonOperatorConfigDocument('{}', operatorConfig);
        } else {
            configDoc = new YamlOperatorConfigDocument('', operatorConfig);
            configDoc.parsed = new YamlDocument({});
        }
        configFromFile = {};
    } else {
        configDoc = doc as (YamlOperatorConfigDocument | JsonOperatorConfigDocument);

        try {
            configFromFile = validateJson(configDoc.toJS(), operatorSchema, initLogger) as OperatorJsonConfig;
            const {
                bots = [],
                logging: {
                    path = undefined
                } = {}
            } = configFromFile || {};
            if(path !== undefined) {
                initLogger.warn(`'path' property in top-level 'logging' object is DEPRECATED and will be removed in next minor version. Use 'logging.file.dirname' instead`);
            }
            for (const b of bots) {
                const {
                    polling: {
                        sharedMod
                    } = {}
                } = b;
                if (sharedMod !== undefined) {
                    initLogger.warn(`'sharedMod' bot config property is DEPRECATED and will be removed in next minor version. Use 'shared' property instead (see docs)`);
                    break;
                }
            }
        } catch (err: any) {
            initLogger.error('Cannot continue app startup because operator config file was not valid.');
            throw err;
        }
    }

    const opConfigFromArgs = parseOpConfigFromArgs(args);
    const opConfigFromEnv = parseOpConfigFromEnv();

    const defaultBotInstanceFromArgs = parseDefaultBotInstanceFromArgs(args);
    const defaultBotInstanceFromEnv = parseDefaultBotInstanceFromEnv();
    const {bots: botInstancesFromFile = [], ...restConfigFile} = configFromFile;

    const mergedConfig = merge.all([opConfigFromEnv, restConfigFile, opConfigFromArgs], {
        arrayMerge: overwriteMerge,
    });

    const defaultBotInstance = merge.all([defaultBotInstanceFromEnv, defaultBotInstanceFromArgs], {
        arrayMerge: overwriteMerge,
    }) as BotInstanceJsonConfig;

    if (configFromFile.caching !== undefined) {
        defaultBotInstance.caching = configFromFile.caching;
    }

    let botInstances: BotInstanceJsonConfig[] = [];
    if (botInstancesFromFile.length === 0) {
        // only add default bot if user supplied any credentials
        // otherwise its most likely just default, empty settings
        if(defaultBotInstance.credentials !== undefined) {
            botInstances = [defaultBotInstance];
        }
    } else {
        botInstances = botInstancesFromFile.map(x => merge.all([defaultBotInstance, x], {arrayMerge: overwriteMerge}));
    }

    return [removeUndefinedKeys({...mergedConfig, bots: botInstances}) as OperatorJsonConfig, {
        document: configDoc,
        isWriteable: writeable
    }];
}

export const buildOperatorConfigWithDefaults = async (data: OperatorJsonConfig): Promise<OperatorConfig> => {
    const {
        mode = 'all',
        operator: {
            name = [],
            display = 'Anonymous',
        } = {},
        logging: {
            level = 'debug',
            path,
            file = {},
            console = {},
            stream = {},
        } = {},
        logging,
        caching: opCache,
        userAgent,
        databaseStatisticsDefaults: {
            minFrequency = 'day',
            frequency = 'day'
        } = {},
        databaseConfig: {
            connection: dbConnection = (process.env.DB_DRIVER ?? 'sqljs') as DatabaseDriverType,
            migrations = {},
            retention,
        } = {},
        web: {
            port = 8085,
            maxLogs = 200,
            databaseConfig: {
                connection: dbConnectionWeb = dbConnection,
                migrations: migrationsWeb = migrations,
            } = {},
            caching: webCaching = {},
            storage: webStorage = undefined,
            session: {
                secret: sessionSecretFromConfig = undefined,
                maxAge: sessionMaxAge = 86400,
                storage: sessionStorage = undefined,
            } = {},
            invites: {
                maxAge: inviteMaxAge = 0,
            } = {},
            clients,
            credentials: webCredentials,
            operators,
        } = {},
        snoowrap: snoowrapOp = {},
        api: {
            port: apiPort = 8095,
            secret: apiSecret = randomId(),
            friendly,
        } = {},
        credentials = {},
        bots = [],
    } = data;

    let cache: StrongCache;
    let defaultProvider: CacheOptions;
    let opActionedEventsMax: number | undefined;
    let opActionedEventsDefault: number = 25;

    const dataDir = process.env.DATA_DIR ?? defaultDataDir;

    if (opCache === undefined) {
        defaultProvider = {
            store: 'memory',
            ...cacheOptDefaults
        };
        cache = {
            ...cacheTTLDefaults,
            provider: defaultProvider,
            actionedEventsDefault: opActionedEventsDefault,
        };

    } else {
        const {provider, actionedEventsMax, actionedEventsDefault = opActionedEventsDefault, ...restConfig} = opCache;

        if (actionedEventsMax !== undefined && actionedEventsMax !== null) {
            opActionedEventsMax = actionedEventsMax;
            opActionedEventsDefault = Math.min(actionedEventsDefault, actionedEventsMax);
        }

        if (typeof provider === 'string') {
            defaultProvider = {
                store: provider as CacheProvider,
                ...cacheOptDefaults
            };
        } else {
            const {ttl = 60, max = 500, store = 'memory', ...rest} = provider || {};
            defaultProvider = {
                store,
                ...cacheOptDefaults,
                ...rest,
            };
        }
        cache = {
            ...cacheTTLDefaults,
            ...restConfig,
            actionedEventsMax: opActionedEventsMax,
            actionedEventsDefault: opActionedEventsDefault,
            provider: defaultProvider,
        }
    }

    const defaultOperators = typeof name === 'string' ? [name] : name;

    const {
        dirname = path,
        ...fileRest
    } = file;

     const defaultWebCredentials = {
         redirectUri: 'http://localhost:8085/callback'
     };

    const loggingOptions: StrongLoggingOptions = {
        level,
        file: {
            level: level,
            dirname,
            ...fileRest,
        },
        stream: {
            level: level,
            ...stream,
        },
        console: {
            level: level,
            ...console,
        }
    };
    const appLogger = getLogger(loggingOptions, 'app');

    const dbConfig = createDatabaseConfig(dbConnection);
    let realdbConnectionWeb: DatabaseDriver = dbConnectionWeb;
    if(typeof dbConnectionWeb === 'string') {
        realdbConnectionWeb = dbConnectionWeb as DatabaseDriverType;
    } else if(!(typeof dbConnection === 'string')) {
        realdbConnectionWeb = {...dbConnection, ...dbConnectionWeb};
    }
    const webDbConfig = createDatabaseConfig(realdbConnectionWeb);

    const config: OperatorConfig = {
        mode,
        operator: {
            name: defaultOperators,
            display,
        },
        logging: loggingOptions,
        caching: cache,
        snoowrap: snoowrapOp,
        databaseStatisticsDefaults: {
            frequency,
            minFrequency
        },
        database: await createAppDatabaseConnection(dbConfig, appLogger),
        databaseConfig: {
            connection: dbConfig,
            migrations,
            retention,
        },
        userAgent,
        web: {
            database: await createWebDatabaseConnection(webDbConfig, appLogger),
            databaseConfig: {
                connection: webDbConfig,
                migrations: migrationsWeb,
            },
            caching: {
                ...defaultProvider,
                ...webCaching
            },
            port,
            storage: webStorage,
            invites: {
                maxAge: inviteMaxAge,
            },
            session: {
                secret: sessionSecretFromConfig,
                maxAge: sessionMaxAge,
                storage: sessionStorage
            },
            maxLogs,
            clients: clients === undefined ? [{host: 'localhost:8095', secret: apiSecret}] : clients,
            credentials: {...defaultWebCredentials, ...webCredentials} as RequiredWebRedditCredentials,
            operators: operators || defaultOperators,
        },
        api: {
            port: apiPort,
            secret: apiSecret,
            friendly
        },
        bots: [],
        credentials,
    };

    config.bots = bots.map(x => buildBotConfig(x, config));

    return config;
}

export const buildBotConfig = (data: BotInstanceJsonConfig, opConfig: OperatorConfig): BotInstanceConfig => {
    const {
        snoowrap: snoowrapOp,
        caching: {
            actionedEventsMax: opActionedEventsMax,
            actionedEventsDefault: opActionedEventsDefault = 25,
            provider: defaultProvider,
        } = {},
        userAgent,
        database,
        databaseStatisticsDefaults: statDefaultsFromOp,
        databaseConfig: {
            retention: retentionFromOp,
        } = {},
    } = opConfig;
    const {
        name: botName,
        filterCriteriaDefaults = filterCriteriaDefault,
        postCheckBehaviorDefaults,
        polling: {
            sharedMod,
            shared = [],
            stagger,
            limit = 100,
            interval = 30,
        } = {},
        queue: {
            maxWorkers = 1,
        } = {},
        caching,
        nanny: {
            softLimit = 250,
            hardLimit = 50
        } = {},
        snoowrap = snoowrapOp,
        databaseStatisticsDefaults = {},
        databaseConfig: {
            retention,
        } = {},
        flowControlDefaults,
        credentials = {},
        subreddits: {
            overrides = [],
            names = [],
            exclude = [],
            wikiConfig = 'botconfig/contextbot',
            dryRun,
            heartbeatInterval = 300,
        } = {},
    } = data;

    let botCache: StrongCache;
    let botActionedEventsDefault: number;

    if (caching === undefined) {

        botCache = {
            ...cacheTTLDefaults,
            actionedEventsDefault: opActionedEventsDefault,
            actionedEventsMax: opActionedEventsMax,
            provider: {...defaultProvider as CacheOptions}
        };
    } else {
        const {
            provider,
            actionedEventsMax = opActionedEventsMax,
            actionedEventsDefault = opActionedEventsDefault,
            ...restConfig
        } = caching;

        botActionedEventsDefault = actionedEventsDefault;
        if (actionedEventsMax !== undefined) {
            botActionedEventsDefault = Math.min(actionedEventsDefault, actionedEventsMax);
        }

        if (typeof provider === 'string') {
            botCache = {
                ...cacheTTLDefaults,
                ...restConfig,
                actionedEventsDefault: botActionedEventsDefault,
                provider: {
                    store: provider as CacheProvider,
                    ...cacheOptDefaults
                }
            }
        } else {
            const {ttl = 60, max = 500, store = 'memory', ...rest} = provider || {};
            botCache = {
                ...cacheTTLDefaults,
                ...restConfig,
                actionedEventsDefault: botActionedEventsDefault,
                actionedEventsMax,
                provider: {
                    store,
                    ...cacheOptDefaults,
                    ...rest,
                },
            }
        }
    }

    let botCreds: BotCredentialsConfig;

    if ((credentials as any).clientId !== undefined) {
        const creds = credentials as RedditCredentials;
        const {
            clientId: ci,
            clientSecret: cs,
            ...restCred
        } = creds;
        botCreds = {
            reddit: {
                clientId: (ci as string),
                clientSecret: (cs as string),
                ...restCred,
            }
        }
    } else {
        const creds = credentials as BotCredentialsJsonConfig;
        const {
            reddit: {
                clientId: ci,
                clientSecret: cs,
                ...restRedditCreds
            },
            ...rest
        } = creds;
        botCreds = {
            reddit: {
                clientId: (ci as string),
                clientSecret: (cs as string),
                ...restRedditCreds,
            },
            ...rest
        }
    }

    if (botCache.provider.prefix === undefined || botCache.provider.prefix === (defaultProvider as CacheOptions).prefix) {
        // need to provide unique prefix to bot
        botCache.provider.prefix = buildCachePrefix([botCache.provider.prefix, 'bot', (botName || objectHash.sha1(botCreds))]);
    }

    let realShared = shared === true ? ['unmoderated', 'modqueue', 'newComm', 'newSub'] : shared;
    if (sharedMod === true) {
        realShared.push('unmoderated');
        realShared.push('modqueue');
    }

    const botLevelStatDefaults = {...statDefaultsFromOp, ...databaseStatisticsDefaults};
    const mergedOverrides = overrides.map(x => {
        const {
            databaseStatisticsDefaults: fromOverride = {},
        } = x;
        return {
            ...x,
            databaseStatisticsDefaults: {...botLevelStatDefaults, ...fromOverride}
        }
    });

    return {
        name: botName,
        snoowrap: snoowrap || {},
        flowControlDefaults,
        filterCriteriaDefaults,
        postCheckBehaviorDefaults,
        database,
        databaseStatisticsDefaults: botLevelStatDefaults,
        databaseConfig: {
          retention: retention ?? retentionFromOp
        },
        subreddits: {
            names,
            exclude,
            wikiConfig,
            heartbeatInterval,
            dryRun,
            overrides: mergedOverrides,
        },
        credentials: botCreds,
        caching: botCache,
        userAgent,
        polling: {
            shared: [...new Set(realShared)] as PollOn[],
            stagger,
            limit,
            interval,
        },
        queue: {
            maxWorkers,
        },
        nanny: {
            softLimit,
            hardLimit
        }
    }
}
