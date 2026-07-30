/* biome-ignore-all lint/suspicious/noThenProperty: Draft 2020-12 defines `then` as a keyword. */

export type JsonSchema = Record<string, unknown>;

export function conditional(
  condition: JsonSchema,
  consequence: JsonSchema,
  alternative?: JsonSchema,
): JsonSchema {
  return {
    if: condition,
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

export function completeEnumArray(property: string, values: readonly string[]): JsonSchema[] {
  return values.map((value) => ({
    properties: {
      [property]: {
        contains: {
          properties: { id: { const: value } },
          required: ["id"],
        },
        minContains: 1,
        maxContains: 1,
      },
    },
  }));
}
