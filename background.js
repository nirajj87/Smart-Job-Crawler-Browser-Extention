let scanRunning = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keepWorkerAlive(work) {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 1000);
  return Promise.resolve()
    .then(work)
    .finally(() => clearInterval(timer));
}

function isJobPage(url) {
  return /naukri\.com|linkedin\.com/i.test(url || '') && !/nlogin|login|checkpoint|uas\/login/i.test(url || '');
}

async function scanTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'perform_full_scan' });
  } catch (error) {
    await delay(1000);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, { action: 'perform_full_scan' });
  }
}

async function openDashboard() {
  const dashUrl = chrome.runtime.getURL('dashboard.html');
  const existing = await chrome.tabs.query({ url: dashUrl });
  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.tabs.reload(existing[0].id);
    return;
  }
  await chrome.tabs.create({ url: dashUrl });
}

async function runScan(tabId) {
  if (scanRunning) return { status: 'busy' };

  const tab = await chrome.tabs.get(tabId);
  if (!tab || !isJobPage(tab.url)) return { status: 'not-job-site' };

  scanRunning = true;
  try {
    return await keepWorkerAlive(async () => {
      await chrome.storage.local.set({
        scanState: { status: 'running', pageUrl: tab.url }
      });

      const response = await scanTab(tab.id);
      const jobs = response?.jobs || [];
      await chrome.storage.local.set({
        latestScan: {
          jobs,
          pageUrl: response?.pageUrl || tab.url,
          scannedAt: Date.now(),
          skippedApplied: response?.skippedApplied || 0
        },
        scanState: { status: 'done', count: jobs.length, pageUrl: response?.pageUrl || tab.url }
      });

      return { status: 'done', count: jobs.length };
    });
  } catch (error) {
    await chrome.storage.local.set({
      latestScan: { jobs: [], pageUrl: tab.url, scannedAt: Date.now(), error: error.message || 'Scan failed' },
      scanState: { status: 'error', pageUrl: tab.url }
    });
    return { status: 'error' };
  } finally {
    scanRunning = false;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'start_scan') {
    runScan(request.tabId)
      .then((result) => {
        sendResponse(result);
        if (request.openDashboard !== false && (result.status === 'done' || result.status === 'error')) {
          openDashboard();
        }
      })
      .catch(() => sendResponse({ status: 'error' }));
    return true;
  }

  if (request.action === 'execute_apply') {
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    chrome.storage.local.get(['appliedHistory'], (res) => {
      const history = res.appliedHistory || [];
      history.unshift({
        title: request.title,
        company: request.company,
        link: request.link,
        postDate: request.postDate,
        platform: request.platform || 'Job',
        applyDate: today,
        time: timeNow
      });
      chrome.storage.local.set({ appliedHistory: history });
    });

    chrome.tabs.create({ url: request.link }, (newTab) => {
      setTimeout(() => {
        chrome.scripting.executeScript({
          target: { tabId: newTab.id },
          files: ['content.js']
        }, () => {
          chrome.tabs.sendMessage(newTab.id, { action: 'fill_form_and_cv' });
        });
      }, 3500);
    });

    sendResponse({ status: 'success' });
  }
});
