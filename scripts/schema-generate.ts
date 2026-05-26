import { writeFile } from 'node:fs/promises';
import { schema } from "@/schema";

const jsonSchema = schema.toJSONSchema();

removeOptionalDefaultFromRequired(jsonSchema, 'modalities');

await writeFile("schema.json", JSON.stringify(jsonSchema, null, 2));

function removeOptionalDefaultFromRequired(value: unknown, propertyName: string): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      removeOptionalDefaultFromRequired(item, propertyName);
    }
    return;
  }

  const node = value as Record<string, unknown>;
  if (Array.isArray(node.required)) {
    node.required = node.required.filter((item) => item !== propertyName);
  }

  for (const child of Object.values(node)) {
    removeOptionalDefaultFromRequired(child, propertyName);
  }
}
