import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const licenseUrl = "https://data.fda.gov.tw/data/opendata/export/37/csv";
const ingredientUrl = "https://data.fda.gov.tw/data/opendata/export/43/csv";

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift() || "");
  return lines.map((line) => {
    const record = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, record[index] || ""]));
  });
}

function parseCsvLine(line) {
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  return row;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[()（）"'.·,，、/\\\-_\s]+/g, "")
    .trim();
}

function latinText(value) {
  return String(value || "").toLowerCase().normalize("NFKC");
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function ingredientMatches(ingredient, name) {
  if (!name) {
    return false;
  }
  if (hasCjk(name)) {
    return normalize(ingredient).includes(normalize(name));
  }
  const haystackTokens = latinText(ingredient).match(/[a-z]+/g) || [];
  const nameTokens = latinText(name).match(/[a-z]+/g) || [];
  if (nameTokens.length === 0) {
    return false;
  }
  let position = 0;
  for (const token of nameTokens) {
    const nextPosition = haystackTokens.indexOf(token, position);
    if (nextPosition === -1) {
      return false;
    }
    position = nextPosition + 1;
  }
  return true;
}

function isTopical(record) {
  const dosage = `${record["劑型"] || ""} ${record["包裝"] || ""}`;
  const routeText = `${record["中文品名"] || ""} ${record["英文品名"] || ""} ${record["劑型"] || ""} ${record["包裝"] || ""}`;
  const excluded = /(鼻用|鼻腔|噴液|噴霧|吸入|點眼|眼用|眼藥|點耳|耳滴|耳用|口內|口腔|懸液|痔|肛門|陰道|私密|nasal|spray|inhal|ophthalm|eye drops|otic|ear drops|oral|orabase|hemorrhoid|haemorrhoid|procto|vaginal)/i.test(routeText);
  if (excluded) {
    return false;
  }
  return /(乳膏|軟膏|凝膠|外用|洗劑|液劑|油膏|cream|ointment|gel|lotion|topical|solution)/i.test(dosage);
}

function splitIngredientName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function loadPotencyLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const names = [row.ingredient, ...(row.aliases || [])].map((name) => String(name || "").toLowerCase().normalize("NFKC").trim()).filter(Boolean);
    for (const name of names) {
      if (!lookup.has(name)) {
        lookup.set(name, []);
      }
      lookup.get(name).push(row);
    }
  }
  return lookup;
}

function hasKnownSteroid(ingredient, lookup) {
  return Boolean(findPotency(ingredient, lookup));
}

function mgPerGram(ingredient) {
  const value = Number.parseFloat(ingredient["含量"]);
  const unit = normalize(ingredient["含量單位"]);
  const description = normalize([ingredient["處方標示"], ingredient["含量描述"]].join(" "));
  if (!Number.isFinite(value)) {
    return null;
  }
  if (unit === "mg" && (description.includes("gm") || description.includes("gram") || description.includes("gcontains"))) {
    return value;
  }
  if (unit === "%") {
    return value * 10;
  }
  return null;
}

function rangeMatches(row, value) {
  if (!Number.isFinite(value)) {
    return row.min_mg_per_g === undefined && row.max_mg_per_g === undefined;
  }
  const min = row.min_mg_per_g ?? Number.NEGATIVE_INFINITY;
  const max = row.max_mg_per_g ?? Number.POSITIVE_INFINITY;
  return value >= min && value <= max;
}

function findPotency(ingredient, lookup, context = null) {
  const mgValue = context ? mgPerGram(context) : null;
  const candidates = [];
  for (const [name, rows] of lookup.entries()) {
    if (ingredientMatches(ingredient, name)) {
      candidates.push(...rows);
    }
  }
  return candidates.find((row) => rangeMatches(row, mgValue)) || candidates.find((row) => {
    return row.min_mg_per_g === undefined && row.max_mg_per_g === undefined;
  }) || candidates[0] || null;
}

async function downloadCsv(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed ${response.status}: ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.subarray(0, 2).toString("utf8") === "PK") {
    return unzipFirstFile(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

function unzipFirstFile(buffer) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Cannot find ZIP central directory.");
  }

  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error("Invalid ZIP central directory.");
  }

  const method = buffer.readUInt16LE(centralOffset + 10);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (method === 0) {
    return compressed;
  }
  if (method === 8) {
    return inflateRawSync(compressed);
  }
  throw new Error(`Unsupported ZIP compression method: ${method}`);
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  const potencyRows = JSON.parse(await readFile(path.join(dataDir, "steroid-potency.json"), "utf8"));
  const potencyLookup = loadPotencyLookup(potencyRows);

  const [licenseCsv, ingredientCsv] = await Promise.all([
    downloadCsv(licenseUrl),
    downloadCsv(ingredientUrl)
  ]);

  console.log("Parsing TFDA license rows...");
  const licenses = parseCsv(licenseCsv).filter(isTopical);
  console.log(`Topical candidate licenses: ${licenses.length}`);
  console.log("Parsing TFDA ingredient rows...");
  const allIngredients = parseCsv(ingredientCsv);
  const ingredients = allIngredients.filter((item) => {
    return hasKnownSteroid(`${item["成分名稱"]} ${item["含量描述"]}`, potencyLookup);
  });
  console.log(`Known steroid ingredient rows: ${ingredients.length}`);
  const ingredientsByLicense = new Map();
  const allIngredientsByLicense = new Map();

  for (const item of allIngredients) {
    const licenseNo = item["許可證字號"];
    if (!allIngredientsByLicense.has(licenseNo)) {
      allIngredientsByLicense.set(licenseNo, []);
    }
    allIngredientsByLicense.get(licenseNo).push(item);
  }

  for (const item of ingredients) {
    const licenseNo = item["許可證字號"];
    if (!ingredientsByLicense.has(licenseNo)) {
      ingredientsByLicense.set(licenseNo, []);
    }
    ingredientsByLicense.get(licenseNo).push(item);
  }

  const products = [];
  const seen = new Set();
  function pushProduct({ license, ingredient, ingredientName, otherIngredients = [], potency, sourceNote }) {
    const licenseNo = license["許可證字號"];
    const key = [
      licenseNo,
      normalize(ingredientName),
      clean(ingredient["含量"]),
      clean(ingredient["含量單位"]),
      clean(ingredient["含量描述"]),
      sourceNote
    ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);

    products.push({
      license_no: clean(licenseNo),
      name_zh: clean(license["中文品名"]),
      name_en: clean(license["英文品名"]),
      aliases: [],
      dosage_form: clean(license["劑型"]),
      package: clean(license["包裝"]),
      drug_category: clean(license["藥品類別"]),
      indication: clean(license["適應症"]),
      ingredient: ingredientName,
      is_combination: otherIngredients.length > 0,
      other_ingredients: otherIngredients,
      strength: clean(ingredient["含量"]),
      strength_unit: clean(ingredient["含量單位"]),
      strength_description: clean([ingredient["處方標示"], ingredient["含量描述"], ingredient["含量"], ingredient["含量單位"]].filter(Boolean).join(" ")),
      potency_class: potency.class,
      source: sourceNote
    });
    return true;
  }

  for (const license of licenses) {
    const licenseNo = license["許可證字號"];
    const matchedIngredients = ingredientsByLicense.get(licenseNo) || [];
    for (const ingredient of matchedIngredients) {
      const ingredientName = splitIngredientName(ingredient["成分名稱"]);
      const licenseIngredients = allIngredientsByLicense.get(licenseNo) || [];
      const otherIngredients = licenseIngredients
        .map((item) => splitIngredientName(item["成分名稱"]))
        .filter((name) => name && normalize(name) !== normalize(ingredientName))
        .filter((name, index, array) => array.findIndex((item) => normalize(item) === normalize(name)) === index);
      const potency = findPotency(ingredientName || license["主成分略述"], potencyLookup, ingredient);
      if (!potency) {
        continue;
      }

      pushProduct({
        license,
        ingredient,
        ingredientName: ingredientName || license["主成分略述"],
        otherIngredients,
        potency,
        sourceNote: "TFDA 9123 未註銷藥品許可證 + 9121 藥品詳細處方成分；強度由本工具校對表對應"
      });
    }
    if (matchedIngredients.length === 0 && clean(license["主成分略述"])) {
      const fallbackIngredient = {
        "處方標示": "",
        "成分名稱": clean(license["主成分略述"]),
        "含量描述": "",
        "含量": "",
        "含量單位": ""
      };
      const potency = findPotency(fallbackIngredient["成分名稱"], potencyLookup, fallbackIngredient);
      if (potency) {
        pushProduct({
          license,
          ingredient: fallbackIngredient,
          ingredientName: fallbackIngredient["成分名稱"],
          potency,
          sourceNote: "TFDA 9123 未註銷藥品許可證主成分略述；9121 詳細成分缺資料，強度由本工具校對表對應"
        });
      }
    }
  }

  products.sort((a, b) => `${a.name_zh}${a.name_en}`.localeCompare(`${b.name_zh}${b.name_en}`, "zh-Hant"));
  const json = `${JSON.stringify(products, null, 2)}\n`;
  await writeFile(path.join(dataDir, "products.json"), json, "utf8");
  await writeFile(path.join(dataDir, "products.js"), `window.STEROID_PRODUCTS = ${json.replace(/\n$/, "")};\n`, "utf8");
  await writeFile(path.join(dataDir, "steroid-potency.js"), `window.STEROID_POTENCY = ${JSON.stringify(potencyRows, null, 2)};\n`, "utf8");

  console.log(`Generated ${products.length} topical steroid product rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
