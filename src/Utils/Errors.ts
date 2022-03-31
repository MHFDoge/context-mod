import {RateLimitError, RequestError, StatusCodeError} from 'snoowrap/dist/errors';
import ExtendableError from "es6-error";
import {ErrorWithCause} from "pony-cause";
import {CheckSummary, RunResult} from "../Common/interfaces";
import {CheckResultEntity} from "../Common/Entities/CheckResultEntity";
import {RunResultEntity} from "../Common/Entities/RunResultEntity";
import {ActionResultEntity} from "../Common/Entities/ActionResultEntity";


export const isRateLimitError = (err: any): err is RateLimitError => {
    return isRequestError(err) && err.name === 'RateLimitError';
}

export const isScopeError = (err: any): boolean => {
    if(isStatusError(err)) {
        const authHeader = err.response.headers['www-authenticate'];
        return authHeader !== undefined && authHeader.includes('insufficient_scope');
    }
    return false;
}

export const getScopeError = (err: any): string | undefined => {
    if(isScopeError(err)) {
        return err.response.headers['www-authenticate'];
    }
    return undefined;
}

export const isStatusError = (err: any): err is StatusCodeError => {
    return isRequestError(err) && err.name === 'StatusCodeError';
}

export const isRequestError = (err: any): err is RequestError => {
    return typeof err === 'object' && err.response !== undefined && err.response !== null && typeof err.response === 'object';
}

export class SimpleError extends ExtendableError {
    code?: string | number;
}

export class CMError extends ErrorWithCause {
    logged: boolean = false;
}

export class ProcessingError<T> extends ErrorWithCause<Error> {
    constructor(msg: string, cause?: any, result?: T) {
        super(msg, cause);
        this.result = result;
    }
    result?: T
}

export class RunProcessingError extends ProcessingError<RunResultEntity> {
}

export class CheckProcessingError extends ProcessingError<CheckResultEntity> {
}

export class ActionProcessingError extends ProcessingError<ActionResultEntity[]> {
}
