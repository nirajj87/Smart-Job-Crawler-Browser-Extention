const EXP_TOLERANCE = 2;
const MAX_SCROLL_PASSES = 8;

window.__jobCrawler = {
  scan() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['appliedHistory', 'keywords', 'totalExp'], async (data) => {
        try {
          const appliedLinks = (data.appliedHistory || []).map((item) => item.link);
          const keywords = data.keywords
            ? data.keywords.toLowerCase().split(',').map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0)
            : [];
          const result = await crawlAndExtractDetails(appliedLinks, keywords, data.totalExp);
          resolve(result);
        } catch (error) {
          resolve({ jobs: [], rawCount: 0, nextUrl: null, experienceFilter: null });
        }
      });
    });
  },

  fill() {
    chrome.storage.local.get(['totalExp', 'noticePeriod', 'resumeData', 'resumeName'], (data) => {
      fillFields(data);
    });
  }
};

if (!window.__jobCrawlerListening) {
  window.__jobCrawlerListening = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "perform_full_scan") {
      window.__jobCrawler.scan().then(sendResponse);
      return true;
    }
    if (request.action === "fill_form_and_cv") {
      window.__jobCrawler.fill();
      sendResponse({ status: "done" });
    }
  });
}

function isRecentJob(job) {
  const onWeekFilter = /(?:\?|&)jobAge=7(?:&|$)|f_TPR=r604800/i.test(location.href);
  if (!job.postDate || job.postDate === 'On this page') return onWeekFilter;
  return isWithinOneWeek(job.postDate);
}

function isWithinOneWeek(dateStr) {
  if (!dateStr) return true;
  const lower = dateStr.toLowerCase();
  if (lower.includes('month') || lower.includes('year') || lower.includes('months') || lower.includes('years')) {
    return false;
  }
  if (lower.includes('week') || lower.includes('weeks')) {
    const match = lower.match(/(\d+)\s*week/);
    if (match && parseInt(match[1], 10) > 1) return false;
  }
  if (lower.includes('day') || lower.includes('days')) {
    const match = lower.match(/(\d+)\s*day/);
    if (match && parseInt(match[1], 10) > 7) return false;
  }
  return true;
}

function parseUserExperience(totalExp) {
  if (totalExp == null || String(totalExp).trim() === '') return null;
  const match = String(totalExp).match(/\d+/);
  if (!match) return null;
  return parseInt(match[0], 10);
}

function isPostedAgo(text, match) {
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 6);
  return /^\s*ago/i.test(after);
}

function firstExperienceMatch(text, pattern) {
  const globalPattern = new RegExp(pattern.source, 'ig');
  let match;
  while ((match = globalPattern.exec(text)) !== null) {
    if (!isPostedAgo(text, match)) return match[0];
  }
  return '';
}

function extractExperience(text) {
  if (!text) return '';
  const patterns = [
    /(\d+)\s*[-–to]+\s*(\d+)\s*(?:yrs?|years?)\s*\+?/i,
    /(\d+)\s*\+\s*(?:yrs?|years?)/i,
    /(\d+)\s*(?:yrs?|years?)\s*\+/i,
    /(?:at least|minimum|min\.?)\s*(\d+)\s*(?:yrs?|years?)/i,
    /(\d+)\s*(?:yrs?|years?)/i
  ];
  for (const pattern of patterns) {
    const found = firstExperienceMatch(text, pattern);
    if (found) return found;
  }
  return '';
}

function highestRequirementYears(text) {
  const years = [];
  const pattern = /(\d+)\s*(?:[-–to]+\s*(\d+))?\s*\+?\s*(?:yrs?|years?)\s*\+?/gi;
  let match;
  const source = text || '';
  while ((match = pattern.exec(source)) !== null) {
    if (isPostedAgo(source, match)) continue;
    years.push(parseInt(match[1], 10));
    if (match[2]) years.push(parseInt(match[2], 10));
  }
  if (years.length === 0) return null;
  return Math.max(...years);
}

function extractSeniority(text) {
  const match = (text || '').match(/\b(internship|entry level|associate|mid-senior level|director|executive)\b/i);
  return match ? match[1] : '';
}

function linkedInSeniority(card) {
  const nodes = card.querySelectorAll(
    '.job-card-container__metadata-item, .job-card-container__footer-item, .job-card-container__metadata-wrapper li, .artdeco-entity-lockup__caption, .job-card-container__job-insight'
  );
  return extractSeniority([...nodes].map((node) => node.innerText).join(' '));
}

function linkedInExperienceMatches(job) {
  const seniority = job.seniority || '';
  if (/mid-senior level|director|executive/i.test(seniority)) return true;
  if (job.requirementYears != null) return job.requirementYears >= 5;
  if (/internship|entry level|associate/i.test(seniority)) return false;
  return true;
}

function isExperienceInRange(expStr, userExp) {
  if (userExp == null) return true;
  if (!expStr) return true;

  const numbers = expStr.match(/\d+/g);
  if (!numbers || numbers.length === 0) return true;

  const minJobExp = parseInt(numbers[0], 10);
  let maxJobExp = minJobExp;
  if (/\+/.test(expStr) && numbers.length === 1) {
    maxJobExp = minJobExp + 20;
  } else if (numbers.length > 1) {
    maxJobExp = parseInt(numbers[1], 10);
  }

  const targetMin = Math.max(0, userExp - EXP_TOLERANCE);
  const targetMax = userExp + EXP_TOLERANCE;
  return maxJobExp >= targetMin && minJobExp <= targetMax;
}

function experienceFilterFor(userExp) {
  if (userExp == null) return null;
  return {
    userExp,
    min: Math.max(0, userExp - EXP_TOLERANCE),
    max: userExp + EXP_TOLERANCE
  };
}

function findResultLists() {
  const known = [...document.querySelectorAll(
    '.jobs-search-results-list, .scaffold-layout__list-container, .jobs-search__results-list, .scaffold-layout__list, [class*="jobs-search-results-list"], [class*="srp-jobtuple-container"]'
  )];
  const scrolling = [...document.querySelectorAll('div, ul')].filter((el) => {
    if (el.scrollHeight < el.clientHeight + 250) return false;
    const style = window.getComputedStyle(el);
    const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (!scrolls) return false;
    return Boolean(el.querySelector('[data-job-id], [data-occludable-job-id], a[href*="currentJobId"], a[href*="/jobs/view/"], a[href*="job-listings"], .srp-jobtuple-wrapper'));
  });
  return [...new Set([...known, ...scrolling])].slice(0, 4);
}

async function scrollResults() {
  const lists = findResultLists();
  if (lists.length > 0) {
    lists.forEach((list) => {
      const step = Math.max(500, Math.floor(list.clientHeight * 0.9));
      list.scrollTop = Math.min(list.scrollHeight, list.scrollTop + step);
    });
  } else {
    window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.9)));
  }
  await new Promise((resolve) => setTimeout(resolve, 450));
}

function postedRank(dateStr) {
  const text = (dateStr || '').toLowerCase();
  if (!text || text === 'on this page') return 50000;
  if (/just now|today|moment|few seconds/.test(text)) return 0;
  if (/yesterday/.test(text)) return 1;
  const minutes = text.match(/(\d+)\s*min/);
  if (minutes) return 0;
  const hours = text.match(/(\d+)\s*hour/);
  if (hours) return 0;
  const days = text.match(/(\d+)\s*day/);
  if (days) return parseInt(days[1], 10);
  const weeks = text.match(/(\d+)\s*week/);
  if (weeks) return parseInt(weeks[1], 10) * 7;
  const months = text.match(/(\d+)\s*month/);
  if (months) return parseInt(months[1], 10) * 30;
  if (text.includes('month')) return 30;
  if (text.includes('week')) return 7;
  return 40000;
}

function queryAllDeep(selector, root = document, depth = 0) {
  if (!root || depth > 5 || typeof root.querySelectorAll !== 'function') return [];
  const found = [...root.querySelectorAll(selector)];
  [...root.querySelectorAll('*')].forEach((el) => {
    if (el.shadowRoot) found.push(...queryAllDeep(selector, el.shadowRoot, depth + 1));
  });
  return found;
}

function cardTextLines(card) {
  return (card.innerText || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function anchorTitle(anchor) {
  const fromText = (anchor.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
  if (fromText && !/^(easy apply|apply|save|dismiss)$/i.test(fromText)) return fromText;
  const label = (anchor.getAttribute('aria-label') || '').trim();
  return label ? label.split(',')[0].trim() : fromText;
}

function buildJobFromAnchor(anchor, platform) {
  const link = (anchor.href || '').split('?')[0];
  if (!link) return null;

  const card = anchor.closest('[data-occludable-job-id], [data-job-id], .job-card-container, .job-card-job-posting-card-wrapper, .jobs-search-results__list-item, .srp-jobtuple-wrapper, .jobTuple, article, li') || anchor;
  const title = anchorTitle(anchor);
  if (!title || title.length < 2 || /^(easy apply|apply|save|dismiss)$/i.test(title)) return null;

  const lines = cardTextLines(card);
  const companyElem = card.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name, .base-search-card__subtitle, .comp-name, .subTitle, a[class*="comp-name"]');
  let company = companyElem ? companyElem.innerText.replace(/\s+/g, ' ').trim() : '';
  if (!company || company === title) {
    company = lines.find((line) => line !== title && line.length < 80 && !/\b(ago|applicant|easy apply|promoted|apply)\b/i.test(line)) || 'Not listed';
  }

  const time = card.querySelector('time, .job-post-day, [class*="job-post-day"]');
  const postDate = (time && (time.innerText || time.getAttribute('datetime') || '').replace(/\s+/g, ' ').trim())
    || lines.find((line) => /\b(ago|today|yesterday|hour|day|week|month|reposted|just now)\b/i.test(line))
    || 'On this page';
  const cardText = card.innerText || '';
  const seniority = platform === 'LinkedIn' ? linkedInSeniority(card) : '';

  return {
    title,
    company,
    postDate,
    link,
    platform,
    experience: extractExperience(cardText) || seniority,
    seniority,
    requirementYears: platform === 'LinkedIn' ? highestRequirementYears(cardText) : null,
    postedRank: postedRank(postDate)
  };
}

function rememberJob(seen, job) {
  if (!job || !job.link) return;
  const existing = seen.get(job.link);
  if (!existing) {
    seen.set(job.link, job);
    return;
  }
  const generic = (item) => !item.company || item.company === 'Not listed' || item.company === item.platform;
  if (generic(existing) && !generic(job)) seen.set(job.link, job);
  else if (job.title.length > existing.title.length && generic(job) === generic(existing)) seen.set(job.link, job);
}

function linkedInIdFromHref(href) {
  try {
    const url = new URL(href, location.href);
    const current = url.searchParams.get('currentJobId');
    if (current && /^\d+$/.test(current)) return current;
    const view = url.pathname.match(/\/jobs\/view\/(?:.*-)?(\d+)/);
    if (view) return view[1];
  } catch (error) {
    return null;
  }
  return null;
}

function jobFromLinkedInCard(card, id) {
  const titleElem = card.querySelector('strong, a[href*="currentJobId"], [class*="title"]');
  const title = (titleElem?.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
  if (!title || /^(easy apply|apply|save|dismiss)$/i.test(title)) return null;
  const fakeAnchor = {
    href: `https://www.linkedin.com/jobs/view/${id}`,
    innerText: title,
    getAttribute: () => '',
    closest: () => card
  };
  return buildJobFromAnchor(fakeAnchor, 'LinkedIn');
}

function extractLinkedInJobs() {
  const seen = new Map();

  queryAllDeep('[data-occludable-job-id], [data-job-id]').forEach((card) => {
    const id = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id');
    if (!id || !/^\d+$/.test(id)) return;
    rememberJob(seen, jobFromLinkedInCard(card, id));
  });

  queryAllDeep('a[href*="currentJobId="], a[href*="/jobs/view/"]').forEach((anchor) => {
    const id = linkedInIdFromHref(anchor.href);
    if (!id) return;
    const card = anchor.closest('[data-occludable-job-id], [data-job-id], li, article, .job-card-container, .job-card-job-posting-card-wrapper') || anchor.parentElement || anchor;
    const fromCard = jobFromLinkedInCard(card, id);
    if (fromCard) rememberJob(seen, fromCard);
    else {
      const built = buildJobFromAnchor(anchor, 'LinkedIn');
      if (built) {
        built.link = `https://www.linkedin.com/jobs/view/${id}`;
        rememberJob(seen, built);
      }
    }
  });

  return [...seen.values()];
}

function isUselessNaukriHref(href) {
  return !href || /javascript:|#|nlogin|mnjuser\/(homepage|profile|recommended|preferences)/i.test(href);
}

function naukriCardLink(card) {
  const preferred = [...card.querySelectorAll('a[href]')].find((anchor) => /job-listing/i.test(anchor.href));
  if (preferred) return preferred.href.split('?')[0];

  const idSource = card.getAttribute('data-job-id')
    || card.querySelector('[data-job-id]')?.getAttribute('data-job-id')
    || card.querySelector('input[type="checkbox"]')?.value
    || '';
  const id = String(idSource).match(/\d{5,}/);
  if (id) return `https://www.naukri.com/job-listings-${id[0]}`;

  const any = [...card.querySelectorAll('a[href]')].find((anchor) => {
    return /naukri\.com/i.test(anchor.href) && !isUselessNaukriHref(anchor.href);
  });
  return any ? any.href.split('?')[0] : '';
}

function findNaukriCards() {
  const found = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!/\d+\s*[-–to]+\s*\d+\s*yrs/i.test(node.nodeValue || '')) continue;
    let el = node.parentElement;
    for (let depth = 0; depth < 8 && el; depth += 1) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > 40 && text.length < 900 && /\b(ago|today)\b/i.test(text)) {
        found.add(el);
        break;
      }
      el = el.parentElement;
    }
  }
  const cards = [...found];
  return cards.filter((card) => !cards.some((other) => other !== card && card.contains(other)));
}

function jobFromNaukriCard(card) {
  const lines = cardTextLines(card).filter((line) => line.length > 1 && !/^(hide|save|applied)$/i.test(line));
  const title = lines.find((line) => !/\b(ago|yrs|lacs|posted by)\b/i.test(line)) || lines[0] || '';
  const link = naukriCardLink(card);
  if (!title || !link) return null;
  const postDate = lines.find((line) => /\b(ago|today)\b/i.test(line)) || 'On this page';
  const company = lines.find((line) => line !== title && !/\b(ago|yrs|lacs|posted by|hiring)\b/i.test(line)) || 'Not listed';
  return {
    title,
    company,
    postDate,
    link,
    platform: 'Naukri',
    experience: extractExperience(card.innerText || ''),
    seniority: '',
    requirementYears: null,
    postedRank: postedRank(postDate)
  };
}

function extractNaukriJobs() {
  const seen = new Map();
  document.querySelectorAll('a[href*="job-listings"], a[href*="job-listing"]').forEach((anchor) => {
    if (isUselessNaukriHref(anchor.href)) return;
    rememberJob(seen, buildJobFromAnchor(anchor, 'Naukri'));
  });
  findNaukriCards().forEach((card) => {
    rememberJob(seen, jobFromNaukriCard(card));
  });
  return [...seen.values()];
}

function extractCurrentPageJobs() {
  const hostname = window.location.hostname;
  if (hostname.includes('linkedin.com')) return extractLinkedInJobs();
  if (hostname.includes('naukri.com')) return extractNaukriJobs();
  return [];
}

function findNextPageUrl() {
  const hostname = window.location.hostname;
  if (hostname.includes("naukri.com")) return naukriNextUrl();
  if (hostname.includes("linkedin.com")) return linkedInNextUrl();
  return null;
}

function isNextControl(el) {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = (el.getAttribute('aria-label') || '').trim();
  const className = typeof el.className === 'string' ? el.className : '';
  return /^next\b/i.test(text) || /^next\b/i.test(label) || /(?:^|[\s_-])next(?:$|[\s_-])/i.test(className);
}

function resultWindow() {
  const text = document.body ? document.body.innerText : '';
  const match = text.match(/(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)/i);
  if (!match) return null;
  return {
    from: parseInt(match[1], 10),
    to: parseInt(match[2], 10),
    total: parseInt(match[3].replace(/,/g, ''), 10)
  };
}

function naukriNextUrl() {
  const info = resultWindow();
  if (info && info.to >= info.total) return null;

  const url = new URL(location.href);
  const current = parseInt(url.searchParams.get('pageNo') || '1', 10);
  const root = document.querySelector('[class*="pagination"]');
  if (root) {
    const controls = [...root.querySelectorAll('a, button')];
    const nextAnchor = controls.find((el) => el.href && isNextControl(el));
    if (nextAnchor) return nextAnchor.href;

    const pageNumbers = controls
      .filter((el) => el.href)
      .map((el) => {
        try {
          return parseInt(new URL(el.href, location.href).searchParams.get('pageNo'), 10);
        } catch (error) {
          return NaN;
        }
      })
      .filter((pageNo) => Number.isFinite(pageNo) && pageNo > current)
      .sort((a, b) => a - b);

    if (pageNumbers.length > 0) {
      url.searchParams.set('pageNo', String(pageNumbers[0]));
      if (!url.searchParams.has('jobAge')) url.searchParams.set('jobAge', '7');
      return url.toString();
    }
  }

  url.searchParams.set('pageNo', String(current + 1));
  if (!url.searchParams.has('jobAge')) url.searchParams.set('jobAge', '7');
  return url.toString();
}

function linkedInNextUrl() {
  const pagination = document.querySelector('.jobs-search-pagination, nav.artdeco-pagination, .artdeco-pagination');
  const nextBtn = pagination
    ? pagination.querySelector('button[aria-label="View next page"], button[aria-label="Next"], button.jobs-search-pagination__button--next, button.artdeco-pagination__button--next')
    : document.querySelector('button.jobs-search-pagination__button--next, button.artdeco-pagination__button--next');
  if (nextBtn && (nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true')) return null;

  const url = new URL(location.href);
  const start = parseInt(url.searchParams.get('start') || '0', 10);
  const currentPage = Math.floor(start / 25) + 1;
  const pageButtons = [...(pagination || document).querySelectorAll('button[aria-label^="Page "]')];
  const hasNumberedNext = pageButtons.some((btn) => {
    const pageNo = parseInt((btn.getAttribute('aria-label') || '').replace(/\D/g, ''), 10);
    return pageNo === currentPage + 1;
  });

  if (!nextBtn && !hasNumberedNext) return null;

  url.searchParams.set('start', String(start + 25));
  return url.toString();
}

async function crawlAndExtractDetails(appliedLinks, keywords, totalExp) {
  const userExp = parseUserExperience(totalExp);
  const seen = new Map();

  const collect = () => {
    extractCurrentPageJobs().forEach((job) => {
      if (!seen.has(job.link)) seen.set(job.link, job);
    });
  };

  const lists = findResultLists();
  const savedListTops = lists.map((list) => list.scrollTop);
  const savedWindowTop = window.scrollY;

  collect();
  for (let pass = 0; pass < MAX_SCROLL_PASSES; pass++) {
    if (seen.size > 0 && pass >= 2) break;
    await scrollResults();
    collect();
  }

  lists.forEach((list, index) => {
    list.scrollTop = savedListTops[index] || 0;
  });
  window.scrollTo(0, savedWindowTop);

  const rawJobs = [...seen.values()];
  const filteredJobs = [];
  let skippedApplied = 0;

  rawJobs.forEach((job) => {
    if (appliedLinks.includes(job.link)) {
      skippedApplied += 1;
      return;
    }

    const titleLower = job.title.toLowerCase();
    const matched = keywords.filter((keyword) => titleLower.includes(keyword));
    const onLinkedIn = window.location.hostname.includes("linkedin.com");
    const experienceMatches = onLinkedIn
      ? linkedInExperienceMatches(job)
      : isExperienceInRange(job.experience, userExp);

    if (!isRecentJob(job)) return;

    filteredJobs.push({
      ...job,
      matchedSkills: matched,
      experienceMatched: experienceMatches,
      keywordMiss: keywords.length > 0 && matched.length === 0
    });
  });

  filteredJobs.sort((a, b) => {
    const freshness = (a.postedRank ?? 50000) - (b.postedRank ?? 50000);
    if (freshness !== 0) return freshness;
    return (b.experienceMatched ? 1 : 0) - (a.experienceMatched ? 1 : 0);
  });

  const datedJobs = rawJobs.filter((job) => job.postDate && job.postDate !== 'On this page');
  let nextUrl = findNextPageUrl();
  if (nextUrl) {
    try {
      const next = new URL(nextUrl, location.href);
      if (location.hostname.includes('naukri.com') && !next.searchParams.has('jobAge')) {
        next.searchParams.set('jobAge', '7');
      }
      nextUrl = next.href.split('#')[0] === location.href.split('#')[0] ? null : next.href;
    } catch (error) {
      nextUrl = null;
    }
  }

  return {
    jobs: filteredJobs,
    rawCount: rawJobs.length,
    weekEnded: datedJobs.length > 0 && datedJobs.every((job) => !isWithinOneWeek(job.postDate)),
    skippedApplied,
    nextUrl,
    pageUrl: window.location.href,
    experienceFilter: window.location.hostname.includes("linkedin.com")
      ? { mode: "five-plus", min: 5, userExp }
      : experienceFilterFor(userExp)
  };
}

function fillFields(userData) {
  const inputs = document.querySelectorAll('input[type="text"], input[type="email"], textarea');
  inputs.forEach((input) => {
    const text = ((input.id ? document.querySelector(`label[for="${input.id}"]`)?.innerText : "") || input.name || input.placeholder || "").toLowerCase();
    if (text.includes("exp") || text.includes("year")) {
      input.value = userData.totalExp;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (text.includes("notice")) {
      input.value = userData.noticePeriod;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  if (userData.resumeData && userData.resumeName) {
    document.querySelectorAll('input[type="file"]').forEach((fileInput) => {
      fetch(userData.resumeData)
        .then((res) => res.blob())
        .then((blob) => {
          const file = new File([blob], userData.resumeName, { type: blob.type });
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });
  }
}
