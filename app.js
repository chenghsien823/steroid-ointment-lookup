(function () {
  const products = Array.isArray(window.STEROID_PRODUCTS) ? window.STEROID_PRODUCTS : [];
  const potencyRows = Array.isArray(window.STEROID_POTENCY) ? window.STEROID_POTENCY : [];
  const form = document.querySelector("#search-form");
  const input = document.querySelector("#query");
  const results = document.querySelector("#results");
  const exampleButtons = document.querySelectorAll("[data-example]");
  let hasUserSearched = false;

  const classMeta = {
    1: { zh: "非常強", note: "最強" },
    2: { zh: "強", note: "強效" },
    3: { zh: "中", note: "中偏強" },
    4: { zh: "中", note: "中等" },
    5: { zh: "中", note: "中偏弱" },
    6: { zh: "弱", note: "弱效" },
    7: { zh: "弱", note: "最弱" }
  };

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

  function text(value, fallback = "未提供") {
    const cleaned = String(value || "").trim();
    return cleaned || fallback;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  function searchableText(product) {
    return searchableFields(product).join(" ");
  }

  function searchableFields(product) {
    return [
      product.license_no,
      product.name_zh,
      product.name_en,
      product.ingredient,
      ...(product.aliases || [])
    ].map(normalize);
  }

  function isOrderedMatch(needle, haystack) {
    let position = 0;
    for (const char of needle) {
      position = haystack.indexOf(char, position);
      if (position === -1) {
        return false;
      }
      position += 1;
    }
    return true;
  }

  function productMatches(product, normalizedQuery) {
    const fields = searchableFields(product);
    if (fields.join(" ").includes(normalizedQuery)) {
      return true;
    }
    if (!hasCjk(normalizedQuery) || normalizedQuery.length < 2) {
      return false;
    }
    return fields.some((field) => hasCjk(field) && isOrderedMatch(normalizedQuery, field));
  }

  function mgPerGram(product) {
    const value = Number.parseFloat(product.strength);
    const unit = normalize(product.strength_unit);
    const description = normalize(product.strength_description);
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

  function findPotency(product) {
    if (product.potency_class) {
      return potencyRows.find((row) => Number(row.class) === Number(product.potency_class)) || {
        class: Number(product.potency_class)
      };
    }

    const ingredient = normalize(product.ingredient);
    const dose = normalize([product.strength, product.strength_unit, product.dosage_form].join(" "));
    const candidates = potencyRows.filter((row) => {
      const names = [row.ingredient, ...(row.aliases || [])];
      return names.some((name) => ingredientMatches(product.ingredient, name));
    });

    const mgValue = mgPerGram(product);
    return candidates.find((row) => {
      if (!rangeMatches(row, mgValue)) {
        return false;
      }
      const matcher = normalize([row.strength_hint, row.vehicle_hint].join(" "));
      return !matcher || dose.includes(matcher);
    }) || candidates.find((row) => rangeMatches(row, null)) || candidates[0] || null;
  }

  function siteGuidance(classNumber) {
    if (classNumber <= 1) {
      return {
        suitable: "厚皮部位、手掌腳掌、嚴重角化病灶；需短期且依醫囑使用",
        caution: "避免臉、眼皮、鼠蹊、腋下、皮膚皺摺、兒童與大面積使用"
      };
    }
    if (classNumber === 2) {
      return {
        suitable: "軀幹、四肢較厚或較嚴重的發炎病灶；通常短期使用",
        caution: "不建議臉、眼皮、鼠蹊、腋下與皮膚皺摺，兒童需醫療人員評估"
      };
    }
    if (classNumber <= 5) {
      return {
        suitable: "多數軀幹與四肢發炎病灶；依病灶嚴重度選擇",
        caution: "臉、眼皮、鼠蹊、腋下、皮膚皺摺只適合短期且需謹慎"
      };
    }
    return {
      suitable: "臉、頸部、皮膚皺摺、兒童或較輕微病灶較常優先考慮",
      caution: "仍避免長期連續使用；眼皮周圍請依醫師或藥師指示"
    };
  }

  function renderProduct(product) {
    const potency = findPotency(product);
    const classNumber = Number(potency && potency.class);
    const meta = classMeta[classNumber] || { note: "未分級", zh: "待校對" };
    const guidance = siteGuidance(classNumber || 7);
    const source = product.source || "TFDA 官方開放資料；強度由本工具校對表對應";

    return `
      <article class="result-card">
        <header class="result-header">
          <div>
            <h2 class="result-title">${escapeHtml(text(product.name_zh))}</h2>
            <p class="result-subtitle">${escapeHtml(text(product.name_en))}</p>
          </div>
          <div class="potency-badge class-${classNumber || 7}">
            <span>美國第 ${escapeHtml(classNumber || "?")} 級</span>
            <strong>${escapeHtml(meta.zh)}</strong>
            <span>${escapeHtml(meta.note)}</span>
          </div>
        </header>
        <div class="result-body">
          <div>
            <div class="field-grid">
              <div class="field"><span>許可證字號</span><strong>${escapeHtml(text(product.license_no))}</strong></div>
              <div class="field"><span>劑型</span><strong>${escapeHtml(text(product.dosage_form))}</strong></div>
              <div class="field"><span>成分</span><strong>${escapeHtml(text(product.ingredient))}</strong></div>
              <div class="field"><span>濃度</span><strong>${escapeHtml(text(product.strength_description || [product.strength, product.strength_unit].filter(Boolean).join(" ")))}</strong></div>
              <div class="field"><span>複方狀態</span><strong>${escapeHtml(product.is_combination ? `複方；其他成分：${(product.other_ingredients || []).join("、") || "詳見仿單"}` : "單一類固醇成分")}</strong></div>
            </div>
            <p class="source-note">${escapeHtml(source)}</p>
          </div>
          <div class="site-list">
            <div><span>適合使用部位</span><strong>${escapeHtml(guidance.suitable)}</strong></div>
            <div><span>需避免或短期使用部位</span><strong class="warning">${escapeHtml(guidance.caution)}</strong></div>
            ${product.is_combination ? '<div><span>複方提醒</span><strong class="warning">複方藥膏可能含抗黴菌、抗生素或其他成分；部位建議仍需依實際診斷調整。</strong></div>' : ""}
          </div>
        </div>
      </article>
    `;
  }

  function renderEmpty(message) {
    results.innerHTML = `
      <div class="results-heading">
        <span>${hasUserSearched ? "搜尋結果" : "準備查詢"}</span>
        <strong>${hasUserSearched ? "查無符合資料" : "請輸入關鍵字"}</strong>
      </div>
      <div class="empty-state">${escapeHtml(message)}</div>
    `;
    focusResults();
  }

  function focusResults() {
    if (!hasUserSearched) {
      return;
    }
    results.classList.remove("results-highlight");
    window.requestAnimationFrame(() => {
      results.classList.add("results-highlight");
      results.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => results.classList.remove("results-highlight"), 1000);
    });
  }

  function search(query) {
    hasUserSearched = true;
    const normalized = normalize(query);
    if (normalized.length < 2) {
      renderEmpty("請輸入至少 2 個字元。可輸入中文商品名、英文商品名或成分名。");
      return;
    }

    const matches = products
      .filter((product) => productMatches(product, normalized))
      .slice(0, 30);

    if (matches.length === 0) {
      renderEmpty("查無符合的外用類固醇資料。若是抗黴菌、抗生素或保濕藥膏，本工具目前不判讀強度。");
      return;
    }

    results.innerHTML = `
      <div class="results-heading">
        <span>搜尋結果</span>
        <strong>找到 ${matches.length} 筆</strong>
      </div>
      ${matches.map(renderProduct).join("")}
    `;
    focusResults();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    search(input.value);
  });

  exampleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.example;
      search(input.value);
    });
  });

  renderEmpty(`目前載入 ${products.length} 筆外用類固醇資料。請輸入商品名或成分開始查詢。`);
})();
