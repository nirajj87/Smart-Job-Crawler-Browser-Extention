document.getElementById('saveConfig').addEventListener('click', () => {
  const fileInput = document.getElementById('resumeFile');
  const keywords = document.getElementById('keywords').value;
  const totalExp = document.getElementById('totalExp').value;
  const noticePeriod = document.getElementById('noticePeriod').value;

  const saveData = (fileData, fileName) => {
    const dataObj = { keywords, totalExp, noticePeriod };
    if (fileData) {
      dataObj.resumeData = fileData;
      dataObj.resumeName = fileName;
    }
    chrome.storage.local.set(dataObj, () => {
      alert("Settings Saved Successfully!");
    });
  };

  if (fileInput.files.length > 0) {
    const reader = new FileReader();
    reader.onload = (e) => saveData(e.target.result, fileInput.files[0].name);
    reader.readAsDataURL(fileInput.files[0]);
  } else {
    saveData(null, null);
  }
});

chrome.storage.local.get(['keywords', 'totalExp', 'noticePeriod'], (res) => {
  if (res.keywords) document.getElementById('keywords').value = res.keywords;
  if (res.totalExp) document.getElementById('totalExp').value = res.totalExp;
  if (res.noticePeriod) document.getElementById('noticePeriod').value = res.noticePeriod;
});

const scanStatus = document.getElementById('scanStatus');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_WEEK_PAGES = 20;

function weekSearchUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (/naukri\.com/i.test(url.hostname)) {
    url.searchParams.set('jobAge', '7');
    if (!url.searchParams.get('pageNo')) url.searchParams.set('pageNo', '1');
    return url.toString();
  }
  if (/linkedin\.com/i.test(url.hostname)) {
    url.searchParams.set('f_TPR', 'r604800');
    if (!url.searchParams.get('start')) url.searchParams.set('start', '0');
    return url.toString();
  }
  return rawUrl;
}

function sameResultsPage(actual, expected) {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    if (left.hostname !== right.hostname) return false;
    if (right.searchParams.has('pageNo')) return left.searchParams.get('pageNo') === right.searchParams.get('pageNo');
    if (right.searchParams.has('start')) return (left.searchParams.get('start') || '0') === right.searchParams.get('start');
    return left.pathname === right.pathname;
  } catch (error) {
    return false;
  }
}

async function goTo(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url && sameResultsPage(tab.url, url)) {
      await wait(1500);
      return;
    }
    await wait(300);
  }
}

async function scanOpenTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'perform_full_scan' });
  } catch (error) {
    await wait(700);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, { action: 'perform_full_scan' });
  }
}

async function scanThisPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const originalUrl = tab?.url || '';
  if (!/https:\/\/([^/]+\.)?(naukri|linkedin)\.com\//i.test(originalUrl)) {
    scanStatus.textContent = 'Pehle Naukri ya LinkedIn ka jobs page kholo, phir extension kholo.';
    return;
  }

  const jobs = [];
  const seenLinks = new Set();
  const visited = new Set();
  let pagesRead = 0;

  try {
    let nextUrl = weekSearchUrl(originalUrl);
    scanStatus.textContent = 'Last 7 days ki jobs dhoondh raha hoon. Popup band mat karna.';

    for (let page = 1; page <= MAX_WEEK_PAGES && nextUrl; page += 1) {
      if (visited.has(nextUrl)) break;
      visited.add(nextUrl);
      if (!sameResultsPage(originalUrl, nextUrl) || /jobAge=7|f_TPR=r604800/i.test(nextUrl)) {
        const current = await chrome.tabs.get(tab.id);
        if (!sameResultsPage(current.url || '', nextUrl)) {
          scanStatus.textContent = `Last 7 days, page ${page} khol raha hoon...`;
          await goTo(tab.id, nextUrl);
        }
      }

      scanStatus.textContent = `Last 7 days: page ${page} padh raha hoon. ${jobs.length} jobs.`;
      const response = await scanOpenTab(tab.id);
      pagesRead += 1;
      (response?.jobs || []).forEach((job) => {
        if (!job.link || seenLinks.has(job.link)) return;
        seenLinks.add(job.link);
        jobs.push(job);
      });

      if (!response?.nextUrl || response.rawCount === 0 || response.weekEnded) break;
      if (page > 1 && (response.jobs || []).length === 0) break;
      nextUrl = response.nextUrl;
    }

    jobs.sort((a, b) => (a.postedRank ?? 50000) - (b.postedRank ?? 50000));
    await chrome.storage.local.set({
      latestScan: {
        jobs,
        pageUrl: originalUrl,
        scannedAt: Date.now(),
        pagesRead
      }
    });
    scanStatus.textContent = jobs.length
      ? `${jobs.length} jobs, last 7 days, ${pagesRead} pages. Dashboard khol raha hoon.`
      : 'Last 7 days me koi job nahi mili.';
    await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  } catch (error) {
    scanStatus.textContent = error?.message || 'Scan start nahi ho paya.';
  } finally {
    try {
      const current = await chrome.tabs.get(tab.id);
      if (current.url !== originalUrl) await chrome.tabs.update(tab.id, { url: originalUrl });
    } catch (error) {
      // The jobs tab may already be closed.
    }
  }
}

scanThisPage();