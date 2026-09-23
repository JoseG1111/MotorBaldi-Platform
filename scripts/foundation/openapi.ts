import parser from "@apidevtools/swagger-parser";
import { openapi } from "@motorbaldi/api/openapi";

await parser.validate(JSON.parse(JSON.stringify(openapi)));
console.log("OpenAPI valid");
