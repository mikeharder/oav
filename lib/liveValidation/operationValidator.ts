import { ParsedUrlQuery } from "querystring";
import { getInfo, MutableStringMap, StringMap } from "@azure-tools/openapi-tools-common";
import { LowerHttpMethods, Operation, Response, TransformFn } from "../swagger/swaggerTypes";
import { sourceMapInfoToSourceLocation } from "../swaggerValidator/ajvSchemaValidator";
import {
  getValidateErrorMessage,
  SchemaValidateContext,
  SchemaValidateIssue,
} from "../swaggerValidator/schemaValidator";
import { jsonPathToPointer } from "../util/jsonUtils";
import { Writable } from "../util/utils";
import {
  errorCodeToErrorMetadata,
  ExtendedErrorCode,
  SourceLocation,
} from "../util/validationError";
import { LiveValidationIssue } from "./liveValidator";
import { LiveValidatorLoader } from "./liveValidatorLoader";
import { OperationMatch } from "./operationSearcher";

export interface ValidationRequest {
  providerNamespace: string;
  resourceType: string;
  apiVersion: string;
  requestMethod: LowerHttpMethods;
  host: string;
  pathStr: string;
  query?: ParsedUrlQuery;
  correlationId?: string;
  requestUrl: string;
}

export interface OperationContext {
  operationId: string;
  apiVersion: string;
  operationMatch?: OperationMatch;
  validationRequest?: ValidationRequest;
}

export interface LiveRequest {
  query?: ParsedUrlQuery;
  readonly url: string;
  readonly method: string;
  headers?: { [propertyName: string]: string };
  body?: StringMap<unknown>;
}

export interface LiveResponse {
  statusCode: string;
  headers?: { [propertyName: string]: string };
  body?: StringMap<unknown>;
}

export const validateSwaggerLiveRequest = async (
  request: LiveRequest,
  info: OperationContext,
  loader?: LiveValidatorLoader,
  includeErrors?: ExtendedErrorCode[]
) => {
  const { pathRegex, pathMatch, operation } = info.operationMatch!;
  const { body, query } = request;
  const result: LiveValidationIssue[] = [];

  let validate = operation._validate;
  if (validate === undefined) {
    if (loader === undefined) {
      throw new Error("Loader is undefined but request validator isn't built yet");
    }
    validate = await loader.getRequestValidator(operation);
  }

  // extract path params
  const pathParam: MutableStringMap<string> = {};
  const _keys = pathRegex._keys;
  for (let idx = 1; idx < pathMatch.length; ++idx) {
    if (_keys[idx] !== undefined) {
      pathParam[_keys[idx]] = decodeURIComponent(pathMatch[idx]);
    }
  }

  transformMapValue(query, operation._queryTransform);
  const headers = transformLiveHeader(request.headers ?? {}, operation);
  validateContentType(operation.consumes!, headers, true, result);

  const ctx = { isResponse: false, includeErrors };
  const errors = validate(ctx, {
    path: pathParam,
    body: transformBodyValue(body, operation),
    headers,
    query,
  });
  schemaValidateIssueToLiveValidationIssue(errors, operation, ctx, result);

  return result;
};

export const validateSwaggerLiveResponse = async (
  response: LiveResponse,
  info: OperationContext,
  loader?: LiveValidatorLoader,
  includeErrors?: ExtendedErrorCode[],
  isArmCall?: boolean
) => {
  const { operation } = info.operationMatch!;
  const { statusCode, body } = response;
  const rspDef = operation.responses;
  const result: LiveValidationIssue[] = [];

  let rsp = rspDef[statusCode];
  const realCode = parseInt(statusCode, 10);
  if (rsp === undefined && 400 <= realCode && realCode <= 599) {
    rsp = rspDef.default;
  }
  if (rsp === undefined) {
    result.push(issueFromErrorCode("INVALID_RESPONSE_CODE", { statusCode }, rspDef));
    return result;
  }

  let validate = rsp._validate;
  if (validate === undefined) {
    if (loader === undefined) {
      throw new Error("Loader is undefined but request validator isn't built yet");
    }
    validate = await loader.getResponseValidator(rsp);
  }

  const headers = transformLiveHeader(response.headers ?? {}, rsp);
  if (rsp.schema !== undefined) {
    validateContentType(operation.produces!, headers, false, result);
    if (isArmCall && realCode >= 200 && realCode < 300) {
      validateLroOperation(operation, statusCode, headers, result);
    }
  }

  const ctx = {
    isResponse: true,
    includeErrors,
    statusCode,
    httpMethod: operation._method,
  };
  const errors = validate(ctx, {
    headers,
    body,
  });
  schemaValidateIssueToLiveValidationIssue(errors, operation, ctx, result);

  return result;
};

const transformBodyValue = (body: any, operation: Operation): any => {
  return operation._bodyTransform === undefined ? body : operation._bodyTransform(body);
};

const transformLiveHeader = (
  headers: StringMap<string>,
  it: Operation | Response
): StringMap<string> => {
  const result: MutableStringMap<string> = {};
  for (const headerName of Object.keys(headers)) {
    result[headerName.toLowerCase()] = headers[headerName];
  }
  transformMapValue(result, it._headerTransform);
  return result;
};

const transformMapValue = (
  data?: MutableStringMap<string | number | boolean | Array<string | number | boolean>>,
  transforms?: StringMap<TransformFn>
) => {
  if (transforms === undefined || data === undefined) {
    return;
  }
  for (const key of Object.keys(transforms)) {
    const transform = transforms[key]!;
    const val = data[key];
    if (typeof val === "string") {
      data[key] = transform(val);
    } else if (Array.isArray(val)) {
      data[key] = val.map(transform as any);
    }
  }
};

const validateContentType = (
  allowedContentTypes: string[],
  headers: StringMap<string>,
  isRequest: boolean,
  result: LiveValidationIssue[]
) => {
  const contentType =
    headers["content-type"]?.split(";")[0] || (isRequest ? undefined : "application/octet-stream");
  if (contentType !== undefined && !allowedContentTypes.includes(contentType)) {
    result.push(
      issueFromErrorCode("INVALID_CONTENT_TYPE", {
        contentType,
        supported: allowedContentTypes.join(", "),
      })
    );
  }
};

const schemaValidateIssueToLiveValidationIssue = (
  input: SchemaValidateIssue[],
  operation: Operation,
  ctx: SchemaValidateContext,
  output: LiveValidationIssue[]
) => {
  for (const i of input) {
    const issue = i as Writable<LiveValidationIssue>;

    const meta = errorCodeToErrorMetadata(issue.code);
    issue.documentationUrl = meta.docUrl;
    issue.severity = meta.severity;

    const source = issue.source as Writable<SourceLocation>;
    if (!source.url) {
      source.url = operation._path._spec._filePath;
    }

    let skipIssue = false;
    issue.pathsInPayload = issue.jsonPathsInPayload.map((path, idx) => {
      const isMissingRequiredProperty = issue.code === "OBJECT_MISSING_REQUIRED_PROPERTY";
      const isBodyIssue = path.startsWith(".body");

      if (isBodyIssue && (path.length > 5 || !isMissingRequiredProperty)) {
        path = "$" + path.substr(5);
        issue.jsonPathsInPayload[idx] = path;
        return jsonPathToPointer(path);
      }

      if (isMissingRequiredProperty) {
        if (ctx.isResponse) {
          if (isBodyIssue) {
            issue.code = "INVALID_RESPONSE_BODY";
            // If a long running operation with code 201 or 202 then it could has empty body
            if (
              operation["x-ms-long-running-operation"] &&
              (ctx.statusCode === "201" || ctx.statusCode === "202")
            ) {
              skipIssue = true;
            }
          } else if (path.startsWith(".headers")) {
            issue.code = "INVALID_RESPONSE_HEADER";
          }
        } else {
          // In request
          issue.code = "MISSING_REQUIRED_PARAMETER";
        }

        issue.severity = errorCodeToErrorMetadata(issue.code).severity;
        issue.message = getValidateErrorMessage(issue.code, { missingProperty: issue.params[0] });
      }

      return jsonPathToPointer(path);
    });

    if (!skipIssue) {
      output.push(issue);
    }
  }
};

const validateLroOperation = (
  operation: Operation,
  statusCode: string,
  headers: StringMap<string>,
  result: LiveValidationIssue[]
) => {
  if (operation["x-ms-long-running-operation"] === true) {
    if (operation._method === "patch" || operation._method === "post") {
      if (statusCode !== "202" && statusCode !== "201") {
        result.push(issueFromErrorCode("LRO_RESPONSE_CODE", { statusCode }, operation.responses));
      } else {
        validateLroHeader(operation, headers, result);
      }
    } else if (operation._method === "delete") {
      if (statusCode !== "202" && statusCode !== "204") {
        result.push(issueFromErrorCode("LRO_RESPONSE_CODE", { statusCode }, operation.responses));
      }
      if (statusCode === "202") {
        validateLroHeader(operation, headers, result);
      }
    } else if (operation._method === "put") {
      if (statusCode === "202" || statusCode === "201") {
        validateLroHeader(operation, headers, result);
      } else if (statusCode !== "200") {
        result.push(issueFromErrorCode("LRO_RESPONSE_CODE", { statusCode }, operation.responses));
      }
    }
  }
};

const validateLroHeader = (
  operation: Operation,
  headers: StringMap<string>,
  result: LiveValidationIssue[]
) => {
  if (
    (headers.location === undefined || headers.location === "") &&
    (headers["azure-AsyncOperation"] === undefined || headers["azure-AsyncOperation"] === "") &&
    (headers["azure-asyncoperation"] === undefined || headers["azure-asyncoperation"] === "")
  ) {
    result.push(
      issueFromErrorCode(
        "LRO_RESPONSE_HEADER",
        {
          header: "location or azure-AsyncOperation",
        },
        operation.responses
      )
    );
  }
};

export const issueFromErrorCode = (
  code: ExtendedErrorCode,
  param: any,
  relatedSchema?: {}
): LiveValidationIssue => {
  const meta = errorCodeToErrorMetadata(code);
  return {
    code,
    severity: meta.severity,
    message: getValidateErrorMessage(code, param),
    jsonPathsInPayload: [],
    pathsInPayload: [],
    schemaPath: "",
    source: sourceMapInfoToSourceLocation(getInfo(relatedSchema)),
    documentationUrl: meta.docUrl,
  };
};
