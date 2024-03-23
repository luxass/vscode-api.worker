import type { JSONSchema4Type } from "json-schema";
import { isPlainObject } from "lodash";
import type { JSONSchema, LinkedJSONSchema } from "./types";
import { Parent } from "./types";

/**
 * Traverses over the schema, giving each node a reference to its
 * parent node. We need this for downstream operations.
 */
export function link(
  schema: JSONSchema4Type | JSONSchema,
  parent: JSONSchema4Type | null = null,
): LinkedJSONSchema {
  if (!Array.isArray(schema) && !isPlainObject(schema)) {
    return schema as LinkedJSONSchema;
  }

  // Handle cycles
  if (Object.prototype.hasOwnProperty.call(schema, Parent)) {
    return schema as LinkedJSONSchema;
  }

  // Add a reference to this schema's parent
  Object.defineProperty(schema, Parent, {
    enumerable: false,
    value: parent,
    writable: false,
  });

  // Arrays
  if (Array.isArray(schema)) {
    schema.forEach((child) => link(child, schema));
  }

  // Objects
  for (const key in schema as JSONSchema) {
    link((schema as JSONSchema)[key], schema);
  }

  return schema as LinkedJSONSchema;
}
