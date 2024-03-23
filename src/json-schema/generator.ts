import { memoize, omit } from "lodash";
import type {
  AST,
  ASTWithStandaloneName,
  TArray,
  TEnum,
  TInterface,
  TIntersection,
  TNamedInterface,
  TUnion,
} from "./types";
import { T_ANY, T_UNKNOWN, hasComment, hasStandaloneName } from "./types";
import { toSafeString } from "./utils";

export function generate(ast: AST): string {
  return `${[
    // options.bannerComment,
    // declareNamedTypes(ast, ast.standaloneName!),
    declareNamedInterfaces(ast, ast.standaloneName!),
    declareEnums(ast),
  ]
    .filter(Boolean)
    .join("\n\n")}\n`; // trailing newline
}

function declareEnums(ast: AST, processed = new Set<AST>()): string {
  if (processed.has(ast)) {
    return "";
  }

  processed.add(ast);
  let type = "";

  switch (ast.type) {
    case "ENUM":
      return `${generateStandaloneEnum(ast)}\n`;
    case "ARRAY":
      return declareEnums(ast.params, processed);
    case "UNION":
    case "INTERSECTION":
      return ast.params.reduce(
        (prev, ast) => prev + declareEnums(ast, processed),
        "",
      );
    case "TUPLE":
      type = ast.params.reduce(
        (prev, ast) => prev + declareEnums(ast, processed),
        "",
      );
      if (ast.spreadParam) {
        type += declareEnums(ast.spreadParam, processed);
      }
      return type;
    case "INTERFACE":
      return getSuperTypesAndParams(ast).reduce(
        (prev, ast) => prev + declareEnums(ast, processed),
        "",
      );
    default:
      return "";
  }
}

function declareNamedInterfaces(
  ast: AST,
  rootASTName: string,
  processed = new Set<AST>(),
): string {
  if (processed.has(ast)) {
    return "";
  }

  processed.add(ast);
  let type = "";

  switch (ast.type) {
    case "ARRAY":
      type = declareNamedInterfaces(
        (ast as TArray).params,
        rootASTName,
        processed,
      );
      break;
    case "INTERFACE": {
      console.log("AST INTERFACE", ast.standaloneName, rootASTName);
      type = [
        hasStandaloneName(ast)
        // && (ast.standaloneName === rootASTName || options.declareExternallyReferenced)
        && ast.standaloneName === rootASTName
        && generateStandaloneInterface(ast),
        getSuperTypesAndParams(ast)
          .map((ast) => declareNamedInterfaces(ast, rootASTName, processed))
          .filter(Boolean)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n");
      break;
    }
    case "INTERSECTION":
    case "TUPLE":
    case "UNION": {
      console.warn("declareNamedInterfaces", ast);
      type = ast.params
        .map((_) => declareNamedInterfaces(_, rootASTName, processed))
        .filter(Boolean)
        .join("\n");
      if (ast.type === "TUPLE" && ast.spreadParam) {
        type += declareNamedInterfaces(ast.spreadParam, rootASTName, processed);
      }
      break;
    }
    default:
      type = "";
  }

  return type;
}

function declareNamedTypes(
  ast: AST,
  rootASTName: string,
  processed = new Set<AST>(),
): string {
  if (processed.has(ast)) {
    return "";
  }

  processed.add(ast);

  switch (ast.type) {
    case "ARRAY":
      return [
        declareNamedTypes(ast.params, rootASTName, processed),
        hasStandaloneName(ast) ? generateStandaloneType(ast) : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    case "ENUM":
      return "";
    case "INTERFACE":
      return getSuperTypesAndParams(ast)
        .map(
          (ast) =>
            // (ast.standaloneName === rootASTName || options.declareExternallyReferenced)
            ast.standaloneName === rootASTName
            && declareNamedTypes(ast, rootASTName, processed),
        )
        .filter(Boolean)
        .join("\n");
    case "INTERSECTION":
    case "TUPLE":
    case "UNION":
      return [
        hasStandaloneName(ast) ? generateStandaloneType(ast) : undefined,
        ast.params
          .map((ast) => declareNamedTypes(ast, rootASTName, processed))
          .filter(Boolean)
          .join("\n"),
        "spreadParam" in ast && ast.spreadParam
          ? declareNamedTypes(ast.spreadParam, rootASTName, processed)
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    default:
      if (hasStandaloneName(ast)) {
        return generateStandaloneType(ast);
      }
      return "";
  }
}

function generateTypeUnmemoized(ast: AST): string {
  const type = generateRawType(ast);

  // if (options.strictIndexSignatures && ast.keyName === "[k: string]") {
  //   return `${type} | undefined`;
  // }

  if (ast.keyName === "[k: string]") {
    console.warn("ASDASDIASIADSIPO TRIGGER [k: string]");
    return `${type} | undefined`;
  }

  return type;
}
export const generateType = memoize(generateTypeUnmemoized);

function generateRawType(ast: AST): string {
  // console.warn("generator", ast);

  if (hasStandaloneName(ast)) {
    return toSafeString(ast.standaloneName);
  }

  switch (ast.type) {
    case "ANY":
      return "any";
    case "ARRAY":
      return (() => {
        const type = generateType(ast.params);
        return type.endsWith("\"") ? `(${type})[]` : `${type}[]`;
      })();
    case "BOOLEAN":
      return "boolean";
    case "INTERFACE":
      return generateInterface(ast);
    case "INTERSECTION":
      return generateSetOperation(ast);
    case "LITERAL":
      return JSON.stringify(ast.params);
    case "NEVER":
      return "never";
    case "NUMBER":
      return "number";
    case "NULL":
      return "null";
    case "OBJECT":
      return "object";
    case "REFERENCE":
      return ast.params;
    case "STRING":
      return "string";
    case "TUPLE":
      return (() => {
        const minItems = ast.minItems;
        const maxItems = ast.maxItems || -1;

        let spreadParam = ast.spreadParam;
        const astParams = [...ast.params];
        if (
          minItems > 0
          && minItems > astParams.length
          && ast.spreadParam === undefined
        ) {
          // this is a valid state, and JSONSchema doesn't care about the item type
          if (maxItems < 0) {
            // no max items and no spread param, so just spread any
            // spreadParam = options.unknownAny ? T_UNKNOWN : T_ANY;
            spreadParam = T_ANY;
          }
        }
        if (maxItems > astParams.length && ast.spreadParam === undefined) {
          // this is a valid state, and JSONSchema doesn't care about the item type
          // fill the tuple with any elements
          for (let i = astParams.length; i < maxItems; i += 1) {
            astParams.push(T_ANY);
            // astParams.push(options.unknownAny ? T_UNKNOWN : T_ANY);
          }
        }

        function addSpreadParam(params: string[]): string[] {
          if (spreadParam) {
            const spread = `...(${generateType(spreadParam)})[]`;
            params.push(spread);
          }
          return params;
        }

        function paramsToString(params: string[]): string {
          return `[${params.join(", ")}]`;
        }

        const paramsList = astParams.map((param) => generateType(param));

        if (paramsList.length > minItems) {
          /*
        if there are more items than the min, we return a union of tuples instead of
        using the optional element operator. This is done because it is more typesafe.

        // optional element operator
        type A = [string, string?, string?]
        const a: A = ['a', undefined, 'c'] // no error

        // union of tuples
        type B = [string] | [string, string] | [string, string, string]
        const b: B = ['a', undefined, 'c'] // TS error
        */

          const cumulativeParamsList: string[] = paramsList.slice(0, minItems);
          const typesToUnion: string[] = [];

          if (cumulativeParamsList.length > 0) {
            // actually has minItems, so add the initial state
            typesToUnion.push(paramsToString(cumulativeParamsList));
          } else {
            // no minItems means it's acceptable to have an empty tuple type
            typesToUnion.push(paramsToString([]));
          }

          for (let i = minItems; i < paramsList.length; i += 1) {
            cumulativeParamsList.push(paramsList[i]);

            if (i === paramsList.length - 1) {
              // only the last item in the union should have the spread parameter
              addSpreadParam(cumulativeParamsList);
            }

            typesToUnion.push(paramsToString(cumulativeParamsList));
          }

          return typesToUnion.join("|");
        }

        // no max items so only need to return one type
        return paramsToString(addSpreadParam(paramsList));
      })();
    case "UNION":
      return generateSetOperation(ast);
    case "UNKNOWN":
      return "unknown";
    case "CUSTOM_TYPE":
      return ast.params;
  }
}

/**
 * Generate a Union or Intersection
 */
function generateSetOperation(ast: TIntersection | TUnion): string {
  const members = (ast as TUnion).params.map((_) => generateType(_));
  const separator = ast.type === "UNION" ? "|" : "&";
  return members.length === 1
    ? members[0]
    : `(${members.join(` ${separator} `)})`;
}

function generateInterface(ast: TInterface): string {
  return (
    `{`
    + `\n${ast.params
      .filter((_) => !_.isPatternProperty && !_.isUnreachableDefinition)
      .map(
        ({ isRequired, keyName, ast }) =>
          [isRequired, keyName, ast, generateType(ast)] as [
            boolean,
            string,
            AST,
            string,
          ],
      )
      .map(
        ([isRequired, keyName, ast, type]) =>
          `${
            (hasComment(ast) && !ast.standaloneName
              ? `${generateComment(ast.comment, ast.deprecated)}\n`
              : "")
              + escapeKeyName(keyName)
              + (isRequired ? "" : "?")
          }: ${type}`,
      )
      .join("\n")}\n`
      + `}`
  );
}

function generateComment(comment?: string, deprecated?: boolean): string {
  const commentLines = ["/**"];
  if (deprecated) {
    commentLines.push(" * @deprecated");
  }
  if (typeof comment !== "undefined") {
    commentLines.push(...comment.split("\n").map((_) => ` * ${_}`));
  }
  commentLines.push(" */");
  return commentLines.join("\n");
}

function generateStandaloneEnum(ast: TEnum): string {
  return (
    `${
      hasComment(ast) ? `${generateComment(ast.comment, ast.deprecated)}\n` : ""
    }export ${
      // options.enableConstEnums ? "const " : ""
      "const "
    }enum ${toSafeString(ast.standaloneName)} {`
    + `\n${ast.params
      .map(({ ast, keyName }) => `${keyName} = ${generateType(ast)}`)
      .join(",\n")}\n`
      + `}`
  );
}

function generateStandaloneInterface(ast: TNamedInterface): string {
  return `${
    hasComment(ast) ? `${generateComment(ast.comment, ast.deprecated)}\n` : ""
  }export interface ${toSafeString(ast.standaloneName)} ${
    ast.superTypes.length > 0
      ? `extends ${ast.superTypes.map((superType) => toSafeString(superType.standaloneName)).join(", ")} `
      : ""
  }${generateInterface(ast)}`;
}

function generateStandaloneType(ast: ASTWithStandaloneName): string {
  return `${
    hasComment(ast) ? `${generateComment(ast.comment)}\n` : ""
  }export type ${toSafeString(ast.standaloneName)} = ${generateType(
    omit<AST>(ast, "standaloneName") as AST /* TODO */,
  )}`;
}

function escapeKeyName(keyName: string): string {
  if (
    keyName.length
    && /[A-Za-z_$]/.test(keyName.charAt(0))
    && /^[\w$]+$/.test(keyName)
  ) {
    return keyName;
  }
  if (keyName === "[k: string]") {
    return keyName;
  }
  return JSON.stringify(keyName);
}

function getSuperTypesAndParams(ast: TInterface): AST[] {
  return ast.params.map((param) => param.ast).concat(ast.superTypes);
}
