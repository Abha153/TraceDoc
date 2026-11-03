import Ajv from "ajv";
import addFormats from "ajv-formats";
import contractSchema from "../../contracts/contracts.schema.json";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export function parseContractFixture<T>(typeName: string, value: unknown): T {
  const validate = ajv.compile<T>({
    definitions: contractSchema.definitions,
    $ref: `#/definitions/${typeName}`,
  });
  if (!validate(value)) {
    throw new Error(`Invalid ${typeName} fixture: ${ajv.errorsText(validate.errors)}`);
  }
  return value;
}
