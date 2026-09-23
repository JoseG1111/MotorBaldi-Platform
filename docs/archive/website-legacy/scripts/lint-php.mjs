import fs from "node:fs/promises";
import phpParser from "php-parser";

const parser = new phpParser.Engine({
  parser: { php7: true, suppressErrors: false },
  ast: { withPositions: true },
});

const files = (await fs.readdir("api"))
  .filter((file) => file.endsWith(".php"))
  .map((file) => `api/${file}`);
for (const file of [...files, "config/hubspot.example.php", "scripts/wompi-check.php", "tests/wompi-state.php"]) {
  const source = await fs.readFile(file, "utf8");
  parser.parseCode(source, file);
  console.log(`${file}: sintaxis válida`);
}
