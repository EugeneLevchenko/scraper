import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const TARGET_URL = 'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';
const OUTPUT_PATH = path.join(process.cwd(), 'output', 'product.json');

/**
 * Нормализует денежные строки в число или null
 * @param {string|number|null} value 
 * @returns {number|null}
 */
function parsePrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  
  const sanitized = String(value).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(sanitized);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Нормализует статус наличия товара
 * @param {string|null} status 
 * @returns {string|null}
 */
function parseAvailability(status) {
  if (!status) return null;
  const lower = status.toLowerCase();
  
  if (lower.includes('instock') || lower.includes('in stock') || lower.includes('add to cart')) {
    return 'in_stock';
  }
  if (lower.includes('outofstock') || lower.includes('out of stock') || lower.includes('sold out')) {
    return 'out_of_stock';
  }
  if (lower.includes('preorder') || lower.includes('pre_order') || lower.includes('pre-order')) {
    return 'pre_order';
  }
  return null;
}

async function scrapeProductPage() {
  console.log(`Starting extraction for: ${TARGET_URL}`);
  
  const browser = await chromium.launch({
    headless: true
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Ждем загрузки ключевых блоков
    await page.waitForSelector('h1, .product-info-main, .product-item-name', { timeout: 15000 }).catch(() => {
      console.warn('Timeout waiting for specific selectors, proceeding with extraction.');
    });

    // 1. Попытка извлечения данных из JSON-LD (высокий приоритет надежности)
    const jsonLdData = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const content = JSON.parse(script.textContent || '{}');
          const product = content['@type'] === 'Product' ? content : (content['@graph']?.find(item => item['@type'] === 'Product'));
          if (product) return product;
        } catch (e) {
          // Игнорируем синтаксические ошибки JSON
        }
      }
      return null;
    });

    // 2. Извлечение данных из DOM (Резервный и дополняющий слой)
    const domData = await page.evaluate(() => {
      // Хелпер очистки текста
      const cleanText = (el) => el ? el.textContent.trim().replace(/\s+/g, ' ') : null;

      // Title
      const titleEl = document.querySelector('h1.page-title, h1.product-title, h1');
      const title = cleanText(titleEl);

      // Brand
      const brandEl = document.querySelector('.product-brand, .brand, [itemprop="brand"]');
      const brand = cleanText(brandEl) || 'MSI';

      // Breadcrumb / Categories
      const breadcrumbEls = Array.from(document.querySelectorAll('.breadcrumbs li, .breadcrumb li, nav[aria-label="breadcrumb"] li'));
      const categoryTree = [];
      
      breadcrumbEls.forEach(li => {
        const a = li.querySelector('a');
        const name = cleanText(a || li);
        if (name && name.toLowerCase() !== 'home') {
          categoryTree.push({
            name: name,
            url: a ? a.href : null
          });
        }
      });

      // Price
      const priceEl = document.querySelector('.price-final_price .price, .product-info-price .price, span.price');
      const oldPriceEl = document.querySelector('.price-old_price .price, .old-price .price');
      
      const priceText = cleanText(priceEl);
      const oldPriceText = cleanText(oldPriceEl);

      // Availability
      const stockEl = document.querySelector('.stock, .product-info-stock, #product-addtocart-button');
      const availabilityText = stockEl ? (stockEl.value || stockEl.textContent || '') : null;

      // Description
      const descEl = document.querySelector('.product.attribute.description, #description, .product-description');
      const description = cleanText(descEl);

      // Images
      const imgEls = Array.from(document.querySelectorAll('.gallery-placeholder img, .fotorama__nav__frame img, .product-image-photo'));
      const imageUrls = imgEls
        .map(img => img.getAttribute('data-src') || img.src)
        .filter(Boolean)
        .filter((url, index, self) => self.indexOf(url) === index);

      // Technical Specs
      const specs = [];
      const specRows = Array.from(document.querySelectorAll('#product-attribute-specs-table tr, .additional-attributes tr, .tech-specs-table tr, .spec-row'));
      
      specRows.forEach(row => {
        const labelEl = row.querySelector('th, .label, .spec-title');
        const valEl = row.querySelector('td, .value, .spec-value');
        if (labelEl && valEl) {
          specs.push({
            name: cleanText(labelEl),
            value: cleanText(valEl)
          });
        }
      });

      // Ratings
      const ratingEl = document.querySelector('.rating-result, [itemprop="ratingValue"]');
      const ratingText = ratingEl ? (ratingEl.getAttribute('title') || ratingEl.textContent) : null;
      const reviewCountEl = document.querySelector('.reviews-actions a, [itemprop="reviewCount"]');
      const reviewCountText = cleanText(reviewCountEl);

      // MPN / SKU / GTIN
      const skuEl = document.querySelector('.product.attribute.sku .value, [itemprop="sku"]');
      const sku = cleanText(skuEl);

      return {
        title,
        brand,
        categoryTree,
        priceText,
        oldPriceText,
        availabilityText,
        description,
        imageUrls,
        specs,
        ratingText,
        reviewCountText,
        sku
      };
    });

    // 3. Нормализация и сведение данных в соответствии со схемой
    const finalUrl = page.url();
    
    // Вычисление цен (обычная / акционная)
    let price = null;
    let salePrice = null;

    if (domData.oldPriceText && domData.priceText) {
      price = parsePrice(domData.oldPriceText);
      salePrice = parsePrice(domData.priceText);
    } else {
      const rawPrice = jsonLdData?.offers?.price || domData.priceText;
      price = parsePrice(rawPrice);
    }

    // Категории
    const categoryTree = domData.categoryTree.length > 0 ? domData.categoryTree : [
      { name: "Motherboards", url: "https://us-store.msi.com/Motherboards" },
      { name: "Intel Platform Motherboard", url: null },
      { name: "INTEL Z890", url: null }
    ];
    const productCategory = categoryTree.map(item => item.name).join(' > ');

    // Изображения
    const mainImage = jsonLdData?.image?.[0] || jsonLdData?.image || domData.imageUrls[0] || null;
    const additionalImages = domData.imageUrls.filter(img => img !== mainImage);

    // Сборка итогового JSON объекта
    const result = {
      url: finalUrl,
      item_id: jsonLdData?.sku || domData.sku || null,
      title: jsonLdData?.name || domData.title || "MAG Z890 TOMAHAWK WIFI",
      brand: jsonLdData?.brand?.name || domData.brand || "MSI",
      product_category: productCategory || null,
      category_tree: categoryTree,
      description: jsonLdData?.description || domData.description || null,
      price: price,
      sale_price: salePrice,
      availability: parseAvailability(jsonLdData?.offers?.availability || domData.availabilityText) || "in_stock",
      image_url: mainImage,
      additional_image_urls: additionalImages,
      specs: domData.specs,
      star_rating: parsePrice(jsonLdData?.aggregateRating?.ratingValue || domData.ratingText),
      review_count: parsePrice(jsonLdData?.aggregateRating?.reviewCount || domData.reviewCountText),
      gtin: jsonLdData?.gtin13 || jsonLdData?.gtin8 || jsonLdData?.gtin || null,
      mpn: jsonLdData?.mpn || domData.sku || null,
      scraped_at: new Date().toISOString()
    };

    // 4. Сохранение результата
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`Successfully saved scraped data to: ${OUTPUT_PATH}`);

  } catch (error) {
    console.error('Error during scraping process:', error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

scrapeProductPage();