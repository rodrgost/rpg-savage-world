/**
 * Converte um schema no formato Gemini (types UPPERCASE: OBJECT/ARRAY/STRING/...,
 * `nullable`, `enum`, `propertyOrdering`) para JSON Schema no formato exigido pelo
 * Structured Outputs da OpenAI (response_format: { type: 'json_schema', json_schema:
 * { strict: true, schema } }).
 *
 * Regras do modo strict da OpenAI que este conversor precisa satisfazer:
 *  - todo nó "object" precisa de additionalProperties: false;
 *  - TODAS as chaves de "properties" devem aparecer em "required" — não existe
 *    campo opcional; um campo que no schema Gemini era omissível (nullable) vira
 *    aqui "obrigatório porém anulável": o "type" passa a ser um array incluindo
 *    "null", e se o campo tiver "enum", "null" precisa entrar na lista do enum
 *    também (senão o valor null bate no "type" mas falha a validação do "enum").
 *
 * IMPORTANTE — não verificado contra uma chamada real à API OpenAI neste ambiente
 * (sem acesso a chave/rede de produção aqui). A validação feita foi estrutural
 * (assertStrictJsonSchemaInvariants abaixo) + a documentação pública da OpenAI no
 * momento em que isto foi escrito. Antes de depender disso em produção, testar com
 * uma chamada real e conferir se o provider aceita response_format=json_schema.
 */

const GEMINI_TO_JSON_SCHEMA_TYPE: Record<string, string> = {
  OBJECT: 'object',
  ARRAY: 'array',
  STRING: 'string',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  NUMBER: 'number'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function convertNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node

  const geminiType = typeof node.type === 'string' ? node.type : undefined
  const mappedType = geminiType ? (GEMINI_TO_JSON_SCHEMA_TYPE[geminiType] ?? geminiType.toLowerCase()) : undefined
  const nullable = node.nullable === true

  const out: Record<string, unknown> = {}

  if (mappedType) {
    out.type = nullable ? [mappedType, 'null'] : mappedType
  }

  if (typeof node.description === 'string') out.description = node.description

  if (Array.isArray(node.enum)) {
    out.enum = nullable ? [...node.enum, null] : [...node.enum]
  }

  if (mappedType === 'object') {
    const properties = isPlainObject(node.properties) ? node.properties : {}
    const convertedProperties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(properties)) {
      convertedProperties[key] = convertNode(value)
    }
    out.properties = convertedProperties
    // Modo strict: TODA chave de properties entra em required — a "opcionalidade"
    // de um campo é expressa via nullable (ver acima), não pela ausência em required.
    out.required = Object.keys(convertedProperties)
    out.additionalProperties = false
  }

  if (mappedType === 'array' && node.items !== undefined) {
    out.items = convertNode(node.items)
  }

  return out
}

/** Converte o schema raiz (sempre um OBJECT no formato Gemini) para JSON Schema strict da OpenAI. */
export function toOpenAiStrictSchema(geminiSchema: Record<string, unknown>): Record<string, unknown> {
  return convertNode(geminiSchema) as Record<string, unknown>
}

/**
 * Monta o objeto response_format.json_schema completo esperado pela API OpenAI
 * (chat.completions com Structured Outputs).
 */
export function buildOpenAiJsonSchemaResponseFormat(
  name: string,
  geminiSchema: Record<string, unknown>
): { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } } {
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: true,
      schema: toOpenAiStrictSchema(geminiSchema)
    }
  }
}

/**
 * Checagem estrutural recursiva dos invariantes exigidos pelo modo strict da
 * OpenAI (additionalProperties: false + required === todas as chaves de
 * properties, em todo nó "object" do schema). Lança erro descrevendo o
 * caminho exato do primeiro nó inválido encontrado — usada em testes/validação
 * manual, não faz parte do caminho de execução em produção.
 */
export function assertStrictJsonSchemaInvariants(schema: unknown, path = '$'): void {
  if (!isPlainObject(schema)) return

  const type = schema.type
  const isObjectType = type === 'object' || (Array.isArray(type) && type.includes('object'))

  if (isObjectType) {
    if (schema.additionalProperties !== false) {
      throw new Error(`${path}: additionalProperties deveria ser false`)
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    const propertyKeys = Object.keys(properties)
    const required = Array.isArray(schema.required) ? schema.required : []
    const sameSet =
      required.length === propertyKeys.length && propertyKeys.every((key) => required.includes(key))
    if (!sameSet) {
      throw new Error(
        `${path}: required deveria conter exatamente as chaves de properties (properties=${JSON.stringify(propertyKeys)}, required=${JSON.stringify(required)})`
      )
    }
    for (const [key, value] of Object.entries(properties)) {
      assertStrictJsonSchemaInvariants(value, `${path}.${key}`)
    }
  }

  const itemsType = Array.isArray(type) ? type.includes('array') : type === 'array'
  if (itemsType && schema.items !== undefined) {
    assertStrictJsonSchemaInvariants(schema.items, `${path}[]`)
  }
}
