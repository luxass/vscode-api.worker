import { findKey, includes, isPlainObject, map, memoize, omit } from "lodash";
import type { JSONSchema4Type, JSONSchema4TypeName } from "json-schema";
import { typesOfSchema } from "./types-of";
import type {
  AST,
  JSONSchemaWithDefinitions,
  JSONSchema as LinkedJSONSchema,
  SchemaSchema,
  SchemaType,
  TEnumParam,
  TInterface,
  TInterfaceParam,
  TIntersection,
  TNamedInterface,
  TTuple,
} from "./types";
import {
  T_ANY,
  T_ANY_ADDITIONAL_PROPERTIES,
  T_UNKNOWN,
  T_UNKNOWN_ADDITIONAL_PROPERTIES,
} from "./types";
import {
  generateName,
  getRootSchema,
  isBoolean,
  isPrimitive,
  maybeStripDefault,
  maybeStripNameHints,
} from "./utils";

interface Definitions {
  [k: string]: LinkedJSONSchema;
}

function getDefinitions(
  schema: LinkedJSONSchema,
  isSchema = true,
  processed = new Set<LinkedJSONSchema>(),
): Definitions {
  if (processed.has(schema)) {
    return {};
  }
  processed.add(schema);
  if (Array.isArray(schema)) {
    return schema.reduce(
      (prev, cur) => ({
        ...prev,
        ...getDefinitions(cur, false, processed),
      }),
      {},
    );
  }
  if (isPlainObject(schema)) {
    return {
      ...(isSchema && hasDefinitions(schema) ? schema.$defs : {}),
      ...Object.keys(schema).reduce<Definitions>(
        (prev, cur) => ({
          ...prev,
          ...getDefinitions(schema[cur], false, processed),
        }),
        {},
      ),
    };
  }
  return {};
}

const getDefinitionsMemoized = memoize(getDefinitions);

// import { generateName, log, maybeStripDefault, maybeStripNameHints } from "./utils";

export type Processed = Map<LinkedJSONSchema, Map<SchemaType, AST>>;

export type UsedNames = Set<string>;

export function parse(
  schema: LinkedJSONSchema | JSONSchema4Type,
  keyName?: string,
  processed: Processed = new Map(),
  usedNames = new Set<string>(),
): AST {
  if (isPrimitive(schema)) {
    if (isBoolean(schema)) {
      return parseBooleanSchema(schema, keyName);
    }

    return parseLiteral(schema, keyName);
  }

  const types = typesOfSchema(schema);
  if (types.length === 1) {
    const ast = parseAsTypeWithCache(
      schema,
      types[0],
      keyName,
      processed,
      usedNames,
    );
    // console.warn("Types:", types, "Input:", schema, "Output:", ast);
    return ast;
  }

  // Be careful to first process the intersection before processing its params,
  // so that it gets first pick for standalone name.
  const ast = parseAsTypeWithCache(
    {
      $id: schema.$id,
      allOf: [],
      description: schema.description,
      title: schema.title,
    },
    "ALL_OF",
    keyName,
    processed,
    usedNames,
  ) as TIntersection;

  ast.params = types.map((type) =>
    // We hoist description (for comment) and id/title (for standaloneName)
    // to the parent intersection type, so we remove it from the children.
    parseAsTypeWithCache(
      maybeStripNameHints(schema),
      type,
      keyName,
      processed,
      usedNames,
    ),
  );

  // console.warn("Types:", types, "Input:", schema, "Output:", ast);
  return ast;
}

function parseAsTypeWithCache(
  schema: LinkedJSONSchema,
  type: SchemaType,
  keyName?: string,
  processed: Processed = new Map(),
  usedNames = new Set<string>(),
): AST {
  // If we've seen this node before, return it.
  let cachedTypeMap = processed.get(schema);
  if (!cachedTypeMap) {
    cachedTypeMap = new Map();
    processed.set(schema, cachedTypeMap);
  }
  const cachedAST = cachedTypeMap.get(type);
  if (cachedAST) {
    return cachedAST;
  }

  // Cache processed ASTs before they are actually computed, then update
  // them in place using set(). This is to avoid cycles.
  // TODO: Investigate alternative approaches (lazy-computing nodes, etc.)
  const ast = {} as AST;
  cachedTypeMap.set(type, ast);

  // Update the AST in place. This updates the `processed` cache, as well
  // as any nodes that directly reference the node.
  return Object.assign(
    ast,
    parseNonLiteral(schema, type, keyName, processed, usedNames),
  );
}

function parseBooleanSchema(schema: boolean, keyName: string | undefined): AST {
  if (schema) {
    return {
      keyName,
      type: "ANY",
      // type: options.unknownAny ? "UNKNOWN" : "ANY",
    };
  }

  return {
    keyName,
    type: "NEVER",
  };
}

function parseLiteral(
  schema: JSONSchema4Type,
  keyName: string | undefined,
): AST {
  return {
    keyName,
    params: schema,
    type: "LITERAL",
  };
}

function parseNonLiteral(
  schema: LinkedJSONSchema,
  type: SchemaType,
  keyName: string | undefined,
  processed: Processed,
  usedNames: UsedNames,
): AST {
  const definitions = getDefinitionsMemoized(getRootSchema(schema as any)); // TODO
  const keyNameFromDefinition = findKey(definitions, (_) => _ === schema);

  switch (type) {
    case "ALL_OF":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        params: schema.allOf!.map((_) =>
          parse(_, undefined, processed, usedNames),
        ),
        type: "INTERSECTION",
      };
    case "ANY":
      return {
        // ...(options.unknownAny ? T_UNKNOWN : T_ANY),
        ...T_ANY,
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
      };
    case "ANY_OF":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        params: schema.anyOf!.map((_) =>
          parse(_, undefined, processed, usedNames),
        ),
        type: "UNION",
      };
    case "BOOLEAN":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "BOOLEAN",
      };
    case "CUSTOM_TYPE":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        params: schema.tsType!,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "CUSTOM_TYPE",
      };
    case "NAMED_ENUM":
      // eslint-disable-next-line no-case-declarations
      let params2: TEnumParam[] = [];

      if (!Array.isArray(schema.enum)) {
        // is an object
        throw new TypeError("schema.enum is an object");
      } else {
        params2 = schema.enum!.map((_, n) => ({
          ast: parseLiteral(_, undefined),
          keyName: schema.tsEnumNames![n],
        }));
      }

      console.log(
        "standalone name",
        standaloneName(schema, keyNameFromDefinition ?? keyName, usedNames)!,
      );

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition ?? keyName,
          usedNames,
        )!,
        params: params2,
        type: "ENUM",
      };
    case "NAMED_SCHEMA":
      return newInterface(
        schema as SchemaSchema,
        processed,
        usedNames,
        keyName,
      );
    case "NEVER":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "NEVER",
      };
    case "NULL":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "NULL",
      };
    case "NUMBER":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "NUMBER",
      };
    case "OBJECT":
      return {
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "OBJECT",
        deprecated: schema.deprecated,
      };
    case "ONE_OF":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        params: schema.oneOf!.map((_) =>
          parse(_, undefined, processed, usedNames),
        ),
        type: "UNION",
      };
    case "REFERENCE":
      throw new Error(
        `Refs should have been resolved by the resolver! - ${schema}`,
      );
    case "STRING":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "STRING",
      };
    case "TYPED_ARRAY":
      if (Array.isArray(schema.items)) {
        // normalised to not be undefined
        const minItems = schema.minItems!;
        const maxItems = schema.maxItems!;
        const arrayType: TTuple = {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          maxItems,
          minItems,
          standaloneName: standaloneName(
            schema,
            keyNameFromDefinition,
            usedNames,
          ),
          params: schema.items.map((_) =>
            parse(_, undefined, processed, usedNames),
          ),
          type: "TUPLE",
        };
        if (schema.additionalItems === true) {
          // arrayType.spreadParam = options.unknownAny ? T_UNKNOWN : T_ANY;
          arrayType.spreadParam = T_ANY;
        } else if (schema.additionalItems) {
          arrayType.spreadParam = parse(
            schema.additionalItems,
            undefined,
            processed,
            usedNames,
          );
        }
        return arrayType;
      } else {
        return {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          standaloneName: standaloneName(
            schema,
            keyNameFromDefinition,
            usedNames,
          ),
          params: parse(
            schema.items!,
            `{keyNameFromDefinition}Items`,
            processed,
            usedNames,
          ),
          type: "ARRAY",
        };
      }
    case "UNION":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        params: (schema.type as JSONSchema4TypeName[]).map((type) => {
          const member: LinkedJSONSchema = {
            ...omit(schema, "$id", "description", "title"),
            type,
          };
          return parse(
            maybeStripDefault(member as any),
            undefined,
            processed,
            usedNames,
          );
        }),
        type: "UNION",
      };
    case "UNNAMED_ENUM":
      // eslint-disable-next-line no-case-declarations
      let params3: AST[] = [];
      if (!Array.isArray(schema.enum)) {
        params3 = Object.values(schema.enum!).map((_) =>
          parseLiteral(_, undefined),
        );
      } else {
        params3 = schema.enum!.map((_) => parseLiteral(_, undefined));
      }
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        params: params3,
        type: "UNION",
      };
    case "UNNAMED_SCHEMA":
      return newInterface(
        schema as SchemaSchema,
        processed,
        usedNames,
        keyName,
        keyNameFromDefinition,
      );
    case "UNTYPED_ARRAY":
      // normalised to not be undefined
      // eslint-disable-next-line no-case-declarations
      const minItems = schema.minItems!;
      // eslint-disable-next-line no-case-declarations
      const maxItems
        = typeof schema.maxItems === "number" ? schema.maxItems : -1;
      // const params = options.unknownAny ? T_UNKNOWN : T_ANY;
      // eslint-disable-next-line no-case-declarations
      const params = T_ANY;
      if (minItems > 0 || maxItems >= 0) {
        return {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          maxItems: schema.maxItems,
          minItems,
          // create a tuple of length N
          params: Array(Math.max(maxItems, minItems) || 0).fill(params),
          // if there is no maximum, then add a spread item to collect the rest
          spreadParam: maxItems >= 0 ? undefined : params,
          standaloneName: standaloneName(
            schema,
            keyNameFromDefinition,
            usedNames,
          ),
          type: "TUPLE",
        };
      }

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        params,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition,
          usedNames,
        ),
        type: "ARRAY",
      };
  }
}

/**
 * Compute a schema name using a series of fallbacks
 */
function standaloneName(
  schema: LinkedJSONSchema,
  keyNameFromDefinition: string | undefined,
  usedNames: UsedNames,
): string | undefined {
  const name = schema.title || schema.$id || keyNameFromDefinition;
  if (name) {
    console.log("name", name);
    return generateName(name, usedNames);
  }
}

function newInterface(
  schema: SchemaSchema,
  processed: Processed,
  usedNames: UsedNames,
  keyName?: string,
  keyNameFromDefinition?: string,
): TInterface {
  const name = standaloneName(schema, keyNameFromDefinition, usedNames)!;
  return {
    comment: schema.description,
    deprecated: schema.deprecated,
    keyName,
    params: parseSchema(schema, processed, usedNames, name),
    standaloneName: name,
    superTypes: parseSuperTypes(schema, processed, usedNames),
    type: "INTERFACE",
  };
}

function parseSuperTypes(
  schema: SchemaSchema,
  processed: Processed,
  usedNames: UsedNames,
): TNamedInterface[] {
  // Type assertion needed because of dereferencing step
  // TODO: Type it upstream
  const superTypes = schema.extends as SchemaSchema[] | undefined;
  if (!superTypes) {
    return [];
  }
  return superTypes.map(
    (_) => parse(_, undefined, processed, usedNames) as TNamedInterface,
  );
}

/**
 * Helper to parse schema properties into params on the parent schema's type
 */
function parseSchema(
  schema: SchemaSchema,
  processed: Processed,
  usedNames: UsedNames,
  parentSchemaName: string,
): TInterfaceParam[] {
  let asts: TInterfaceParam[] = map(
    schema.properties,
    (value, key: string) => ({
      ast: parse(value, key, processed, usedNames),
      isPatternProperty: false,
      isRequired: includes(schema.required || [], key),
      isUnreachableDefinition: false,
      keyName: key,
    }),
  );

  let singlePatternProperty = false;
  if (schema.patternProperties) {
    // partially support patternProperties. in the case that
    // additionalProperties is not set, and there is only a single
    // value definition, we can validate against that.
    singlePatternProperty
      = !schema.additionalProperties
      && Object.keys(schema.patternProperties).length === 1;

    asts = asts.concat(
      map(schema.patternProperties, (value, key: string) => {
        const ast = parse(value, key, processed, usedNames);
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema definition
via the \`patternProperty\` "${key.replace("*/", "*\\/")}".`;
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment;
        return {
          ast,
          isPatternProperty: !singlePatternProperty,
          isRequired:
            singlePatternProperty || includes(schema.required || [], key),
          isUnreachableDefinition: false,
          keyName: singlePatternProperty ? "[k: string]" : key,
        };
      }),
    );
  }

  if (true) {
    asts = asts.concat(
      map(schema.$defs, (value, key: string) => {
        const ast = parse(value, key, processed, usedNames);
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema
via the \`definition\` "${key}".`;
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment;
        return {
          ast,
          isPatternProperty: false,
          isRequired: includes(schema.required || [], key),
          isUnreachableDefinition: true,
          keyName: key,
        };
      }),
    );
  }

  // handle additionalProperties
  switch (schema.additionalProperties) {
    case undefined:
    case true:
      if (singlePatternProperty) {
        return asts;
      }
      return asts.concat({
        ast: T_ANY_ADDITIONAL_PROPERTIES,
        // ast: options.unknownAny ? T_UNKNOWN_ADDITIONAL_PROPERTIES : T_ANY_ADDITIONAL_PROPERTIES,
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: "[k: string]",
      });

    case false:
      return asts;

    // pass "true" as the last param because in TS, properties
    // defined via index signatures are already optional
    default:
      return asts.concat({
        ast: parse(
          schema.additionalProperties,
          "[k: string]",
          processed,
          usedNames,
        ),
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: "[k: string]",
      });
  }
}

/**
 * TODO: Reduce rate of false positives
 */
function hasDefinitions(
  schema: LinkedJSONSchema,
): schema is JSONSchemaWithDefinitions {
  return "$defs" in schema;
}
