import { readFile, writeFile } from "fs/promises";
import { join } from "path";


!async function() {

const input: [{
    short_name: string;
    unified: string;
}] = JSON.parse(await readFile(join(__dirname, "emoji.json"), {
    encoding: "utf-8"
}));

const output: Record<string, string> = {};

for (const item of input) {
    output[item.short_name] = item.unified
        .split("-")
        .map(char => String.fromCodePoint(parseInt(char, 16)))
        .join("");
}

await writeFile(join(__dirname, "emoji-map.json"), JSON.stringify(output));

}();