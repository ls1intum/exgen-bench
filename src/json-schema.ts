export type JsonSchema = Record<string, unknown>;

export function conditional(
  condition: JsonSchema,
  consequence: JsonSchema,
  alternative?: JsonSchema,
): JsonSchema {
  return {
    if: condition,
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema 2020-12 keyword.
    then: consequence,
    ...(alternative ? { else: alternative } : {}),
  };
}

export function when(property: string, value: unknown, constraint: JsonSchema): JsonSchema {
  return conditional(
    {
      properties: { [property]: { const: value } },
      required: [property],
    },
    constraint,
  );
}
