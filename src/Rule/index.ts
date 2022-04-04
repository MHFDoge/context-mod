import Snoowrap, {Comment} from "snoowrap";
import Submission from "snoowrap/dist/objects/Submission";
import {Logger} from "winston";
import {findResultByPremise, mergeArr} from "../util";
import {checkAuthorFilter, checkItemFilter, SubredditResources} from "../Subreddit/SubredditResources";
import {
    ChecksActivityState,
    ObjectPremise,
    ResultContext,
    RuleResult as IRuleResult,
    RunnableBaseOptions,
    TypedActivityStates
} from "../Common/interfaces";
import {AuthorOptions, normalizeAuthorCriteria} from "../Author/Author";
import {runCheckOptions} from "../Subreddit/Manager";
import {RuleResultEntity} from "../Common/Entities/RuleResultEntity";
import {RuleType} from "../Common/Entities/RuleType";
import {RulePremise} from "../Common/Entities/RulePremise";
import {capitalize} from "lodash";
import {RunnableBase} from "../Common/RunnableBase";
import {FindOptionsWhere} from "typeorm/find-options/FindOptionsWhere";

export interface RuleOptions extends RunnableBaseOptions {
    name?: string;
    subredditName: string;
    client: Snoowrap
}

export interface Triggerable {
    run(item: Comment | Submission, existingResults: RuleResultEntity[], options: runCheckOptions): Promise<[(boolean | null), RuleResultEntity?]>;
}

export abstract class Rule extends RunnableBase implements IRule, Triggerable {
    name?: string;
    logger: Logger
    client: Snoowrap;
    rulePremiseEntity: RulePremise | null = null;

    constructor(options: RuleOptions) {
        super(options);
        const {
            name,
            logger,
            subredditName,
            client,
        } = options;
        this.name = name;
        this.client = client;

        this.logger = logger.child({labels: [`Rule ${this.getRuleUniqueName()}`]}, mergeArr);
    }

    async initialize() {
        if (this.rulePremiseEntity === null) {
            const prem = this.getPremise();
            const kind = await this.resources.database.getRepository(RuleType).findOne({where: {name: this.getKind()}});
            const candidatePremise = new RulePremise({
                kind: kind as RuleType,
                config: prem,
                manager: this.resources.managerEntity,
                name: this.name,
            });

            const rulePremiseRepo = this.resources.database.getRepository(RulePremise);

            const searchCriteria: FindOptionsWhere<RulePremise> = {
                kind: {
                    id: kind?.id
                },
                configHash: candidatePremise.configHash,
                manager: {
                id: this.resources.managerEntity.id
                },
                itemIsConfigHash: candidatePremise.itemIsConfigHash,
                authorIsConfigHash: candidatePremise.authorIsConfigHash,
                name: this.name
            };
            if(this.name !== undefined) {
                searchCriteria.name = this.name;
            }

            try {

                this.rulePremiseEntity = await rulePremiseRepo.findOne({
                    where: searchCriteria
                });
                if (this.rulePremiseEntity === null) {
                    this.rulePremiseEntity = await rulePremiseRepo.save(candidatePremise);
                }
            } catch (err) {
                const f = err;
            }
        }
    }

    async run(item: Comment | Submission, existingResults: RuleResultEntity[] = [], options: runCheckOptions): Promise<[(boolean | null), RuleResultEntity]> {

        const res = new RuleResultEntity({
            premise: this.rulePremiseEntity as RulePremise
        });

        try {
            const existingResult = findResultByPremise(this.rulePremiseEntity as RulePremise, existingResults);
            if (existingResult !== undefined) {
                this.logger.debug(`Returning existing result of ${existingResult.triggered ? '✔️' : '❌'}`);
                return Promise.resolve([existingResult.triggered ?? null, existingResult]);
            }
            const [itemPass, itemFilterType, itemFilterResults] = await checkItemFilter(item, this.itemIs, this.resources, this.logger, options.source);
            if(this.itemIs.length > 0) {
                res.itemIs = itemFilterResults;
            }
            if (!itemPass) {
                this.logger.verbose(`(Skipped) Item did not pass 'itemIs' test`);
                res.result = `Item did not pass 'itemIs' test`;
                return Promise.resolve([null, res]);
            }
            const [authFilterResult, authFilterType, authFilterRes] = await checkAuthorFilter(item, this.authorIs, this.resources, this.logger);
            if(authFilterType !== undefined) {
                res.authorIs = authFilterRes;
            }
            if(!authFilterResult) {
                this.logger.verbose(`(Skipped) ${authFilterType} Author criteria not matched`);
                res.result = `${authFilterType} author criteria not matched`;
                return Promise.resolve([null, res]);
            }
        } catch (err: any) {
            this.logger.error('Error occurred during Rule pre-process checks');
            throw err;
        }
        try {
            const [triggered, plainRuleResult] = await this.process(item);
            res.triggered = triggered;
            res.result = plainRuleResult.result;
            res.fromCache = false;
            res.data = plainRuleResult.data;
            return [triggered, res];
        } catch (err: any) {
            this.logger.error('Error occurred while processing rule');
            throw err;
        }
    }

    protected abstract process(item: Comment | Submission): Promise<[boolean, IRuleResult]>;

    abstract getKind(): string;

    getRuleUniqueName() {
        return this.name === undefined ? capitalize(this.getKind()) : `${capitalize(this.getKind())} - ${this.name}`;
    }

    protected abstract getSpecificPremise(): object;

    getPremise(): ObjectPremise {
        const config = this.getSpecificPremise();
        return {
            kind: this.getKind(),
            config,
            authorIs: this.authorIs,
            itemIs: this.itemIs,
        };
    }

    protected getResult(triggered: (boolean | null) = null, context: ResultContext = {}): IRuleResult {
        return {
            premise: this.getPremise(),
            kind: this.getKind(),
            name: this.getRuleUniqueName(),
            triggered,
            ...context,
        };
    }
}

export interface UserNoteCriteria {
    /**
     * User Note type key to search for
     * @examples ["spamwarn"]
     * */
    type: string;
    /**
     * Number of occurrences of this type. Ignored if `search` is `current`
     *
     * A string containing a comparison operator and/or a value to compare number of occurrences against
     *
     * The syntax is `(< OR > OR <= OR >=) <number>[percent sign] [ascending|descending]`
     *
     * @examples [">= 1"]
     * @default ">= 1"
     * @pattern ^\s*(?<opStr>>|>=|<|<=)\s*(?<value>\d+)\s*(?<percent>%?)\s*(?<extra>asc.*|desc.*)*$
     * */
    count?: string;

    /**
     * How to test the notes for this Author:
     *
     * ### current
     *
     * Only the most recent note is checked for `type`
     *
     * ### total
     *
     * The `count` comparison of `type` must be found within all notes
     *
     * * EX `count: > 3`   => Must have more than 3 notes of `type`, total
     * * EX `count: <= 25%` => Must have 25% or less of notes of `type`, total
     *
     * ### consecutive
     *
     * The `count` **number** of `type` notes must be found in a row.
     *
     * You may also specify the time-based order in which to search the notes by specifying `ascending (asc)` or `descending (desc)` in the `count` value. Default is `descending`
     *
     * * EX `count: >= 3` => Must have 3 or more notes of `type` consecutively, in descending order
     * * EX `count: < 2`  => Must have less than 2 notes of `type` consecutively, in descending order
     * * EX `count: > 4 asc` => Must have greater than 4 notes of `type` consecutively, in ascending order
     *
     * @examples ["current"]
     * @default current
     * */
    search?: 'current' | 'consecutive' | 'total'
}

export interface IRule extends ChecksActivityState {
    /**
     * An optional, but highly recommended, friendly name for this rule. If not present will default to `kind`.
     *
     * Can only contain letters, numbers, underscore, spaces, and dashes
     *
     * name is used to reference Rule result data during Action content templating. See CommentAction or ReportAction for more details.
     * @pattern ^[a-zA-Z]([\w -]*[\w])?$
     * @examples ["myNewRule"]
     * */
    name?: string
    /**
     * If present then these Author criteria are checked before running the rule. If criteria fails then the rule is skipped.
     * */
    authorIs?: AuthorOptions
    /**
     * A list of criteria to test the state of the `Activity` against before running the Rule.
     *
     * If any set of criteria passes the Rule will be run. If the criteria fails then the Rule is skipped.
     *
     * */
    itemIs?: TypedActivityStates
}

export interface RuleJSONConfig extends IRule {
    /**
     * The kind of rule to run
     * @examples ["recentActivity", "repeatActivity", "author", "attribution", "history"]
     */
    kind: 'recentActivity' | 'repeatActivity' | 'author' | 'attribution' | 'history' | 'regex' | 'repost'
}

