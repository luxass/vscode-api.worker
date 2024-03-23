import type { JSONSchemaTypeName, LinkedJSONSchema, NormalizedJSONSchema } from "./types";
import { Parent } from "./types";
import {
  appendToDescription,
  escapeBlockComment,
  isSchemaLike,
  justName,
  toSafeString,
  traverse,
} from "./utils";

type Rule = (
  schema: LinkedJSONSchema,
  fileName: string,
  key: string | null,
) => void;
const rules = new Map<string, Rule>();

function hasType(schema: LinkedJSONSchema, type: JSONSchemaTypeName) {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}
function isObjectType(schema: LinkedJSONSchema) {
  return schema.properties !== undefined || hasType(schema, "object") || hasType(schema, "any");
}
function isArrayType(schema: LinkedJSONSchema) {
  return schema.items !== undefined || hasType(schema, "array") || hasType(schema, "any");
}

rules.set("Remove `type=[\"null\"]` if `enum=[null]`", (schema) => {
  if (
    Array.isArray(schema.enum)
    && schema.enum.includes(null)
    && Array.isArray(schema.type)
    && schema.type.includes("null")
  ) {
    schema.type = schema.type.filter((type) => type !== "null");
  }
});

rules.set("Destructure unary types", (schema) => {
  if (schema.type && Array.isArray(schema.type) && schema.type.length === 1) {
    schema.type = schema.type[0];
  }
});

rules.set("Add empty `required` property if none is defined", (schema) => {
  if (isObjectType(schema) && !("required" in schema)) {
    schema.required = [];
  }
});

rules.set("Transform `required`=false to `required`=[]", (schema) => {
  if (schema.required === false) {
    schema.required = [];
  }
});

rules.set("Default additionalProperties", (schema, _) => {
  if (isObjectType(schema) && !("additionalProperties" in schema) && schema.patternProperties === undefined) {
    schema.additionalProperties = true;
  }
});

rules.set("Transform id to $id", (schema, fileName) => {
  if (!isSchemaLike(schema)) {
    return;
  }
  if (schema.id && schema.$id && schema.id !== schema.$id) {
    throw new ReferenceError(
      `Schema must define either id or $id, not both. Given id=${schema.id}, $id=${schema.$id} in ${fileName}`,
    );
  }
  if (schema.id) {
    schema.$id = schema.id;
    delete schema.id;
  }
});

rules.set("Escape closing JSDoc comment", (schema) => {
  escapeBlockComment(schema);
});

rules.set("Add JSDoc comments for minItems and maxItems", (schema) => {
  if (!isArrayType(schema)) {
    return;
  }
  const commentsToAppend = [
    "minItems" in schema ? `@minItems ${schema.minItems}` : "",
    "maxItems" in schema ? `@maxItems ${schema.maxItems}` : "",
  ].filter(Boolean);
  if (commentsToAppend.length) {
    schema.description = appendToDescription(schema.description, ...commentsToAppend);
  }
});

rules.set("Optionally remove maxItems and minItems", (schema, _fileName) => {
  if (!isArrayType(schema)) {
    return;
  }
  if ("minItems" in schema) {
    delete schema.minItems;
  }
  if ("maxItems" in schema) {
    delete schema.maxItems;
  }
});

rules.set("Normalize schema.minItems", (schema, _fileName) => {
  // make sure we only add the props onto array types
  if (!isArrayType(schema)) {
    return;
  }
  const { minItems } = schema;
  schema.minItems = typeof minItems === "number" ? minItems : 0;
  // cannot normalize maxItems because maxItems = 0 has an actual meaning
});

rules.set("Remove maxItems if it is big enough to likely cause OOMs", (schema, _fileName) => {
  if (!isArrayType(schema)) {
    return;
  }
  const { maxItems, minItems } = schema;
  // minItems is guaranteed to be a number after the previous rule runs
  if (maxItems !== undefined && maxItems - (minItems as number) > 20) {
    delete schema.maxItems;
  }
});

rules.set("Normalize schema.items", (schema, _fileName) => {
  const { maxItems, minItems } = schema;
  const hasMaxItems = typeof maxItems === "number" && maxItems >= 0;
  const hasMinItems = typeof minItems === "number" && minItems > 0;

  if (schema.items && !Array.isArray(schema.items) && (hasMaxItems || hasMinItems)) {
    const items = schema.items;
    // create a tuple of length N
    const newItems = Array(maxItems || minItems || 0).fill(items);
    if (!hasMaxItems) {
      // if there is no maximum, then add a spread item to collect the rest
      schema.additionalItems = items;
    }
    schema.items = newItems;
  }

  if (Array.isArray(schema.items) && hasMaxItems && maxItems! < schema.items.length) {
    // it's perfectly valid to provide 5 item defs but require maxItems 1
    // obviously we shouldn't emit a type for items that aren't expected
    schema.items = schema.items.slice(0, maxItems);
  }

  return schema;
});

rules.set("Remove extends, if it is empty", (schema) => {
  if (!Object.prototype.hasOwnProperty.call(schema, "extends")) {
    return;
  }
  if (schema.extends == null || (Array.isArray(schema.extends) && schema.extends.length === 0)) {
    delete schema.extends;
  }
});

rules.set("Make extends always an array, if it is defined", (schema) => {
  if (schema.extends == null) {
    return;
  }
  if (!Array.isArray(schema.extends)) {
    schema.extends = [schema.extends];
  }
});

rules.set("Transform const to singleton enum", (schema) => {
  if (schema.const !== undefined) {
    schema.enum = [schema.const];
    delete schema.const;
  }
});

export function normalize(
  rootSchema: LinkedJSONSchema,
  filename: string,
): NormalizedJSONSchema {
  rules.forEach((rule) => traverse(rootSchema, (schema, key) => rule(schema, filename, key)));
  return rootSchema as NormalizedJSONSchema;
}
