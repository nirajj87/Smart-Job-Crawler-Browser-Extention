function loadDashboardData() {
  chrome.storage.local.get(['appliedHistory'], (res) => {
    const historyListDiv = document.getElementById('historyList');
    historyListDiv.innerHTML = "";
    
    const history = res.appliedHistory || [];
    if (history.length === 0) {
      historyListDiv.innerHTML = "No applications recorded yet.";
      return;
    }

    const grouped = {};
    history.forEach(item => {
      const dateKey = item.applyDate || "Recent";
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(item);
    });

    for (const [dateStr, jobs] of Object.entries(grouped)) {
      const dateHeader = document.createElement('div');
      dateHeader.className = 'date-header';
      dateHeader.innerText = `📅 Date: ${dateStr} (${jobs.length} Applied)`;
      historyListDiv.appendChild(dateHeader);

      jobs.forEach((job, idx) => {
        const card = document.createElement('div');
        card.className = 'job-card';
        const platformBadge = `<span style="background: #e2e8f0; color: #1e293b; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; float: right;">${job.platform || 'Job'}</span>`;
        
        card.innerHTML = `
          ${platformBadge}
          <strong>${idx + 1}. ${job.title}</strong><br>
          <span>Company: <b>${job.company}</b></span><br>
          <span style="color:#555; font-size:11px;">Posted: ${job.postDate} | Applied Time: ${job.time}</span><br>
          <a href="${job.link}" target="_blank" style="color:#0073b1; font-weight:bold;">View Job Link</a>
        `;
        historyListDiv.appendChild(card);
      });
    }
  });
}

loadDashboardData();
showLatestScan();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 42 ? parsed.pathname.slice(0, 42) + '…' : parsed.pathname;
    return parsed.hostname + path;
  } catch (error) {
    return url || 'the open tab';
  }
}

function showLatestScan(scan) {
  const statusDiv = document.getElementById('scanStatus');
  const scannedDiv = document.getElementById('scannedList');
  const render = (saved) => {
    const jobs = saved?.jobs || [];
    if (!saved) {
      statusDiv.innerText = '';
      scannedDiv.innerHTML = 'Open the extension on the Naukri or LinkedIn page. This list appears after that scan finishes.';
      return;
    }
    if (saved.error) {
      statusDiv.innerText = 'The scan on that page did not finish.';
      scannedDiv.innerHTML = 'Go back to the Naukri or LinkedIn page and open the extension again.';
      return;
    }
    if (jobs.length === 0) {
      statusDiv.innerText = `Scan finished. No jobs were found on ${shortUrl(saved.pageUrl)}.`;
      scannedDiv.innerHTML = 'Stay on the page where the job list is visible, then open the extension again.';
      return;
    }
    const naukri = jobs.filter((job) => job.platform === 'Naukri').length;
    const linkedin = jobs.filter((job) => job.platform === 'LinkedIn').length;
    const pagesNote = saved.pagesRead ? ` Last 7 days across ${saved.pagesRead} pages.` : '';
    statusDiv.innerText = `Ready to apply: ${jobs.length} jobs from ${shortUrl(saved.pageUrl)}. Naukri ${naukri}, LinkedIn ${linkedin}.${pagesNote}`;
    appendScannedJobs(jobs, 0);
  };

  if (scan) {
    render(scan);
    return;
  }
  chrome.storage.local.get(['latestScan'], (res) => render(res.latestScan));
}

function appendScannedJobs(jobs, startIndex) {
  const scannedDiv = document.getElementById('scannedList');
  if (startIndex === 0) scannedDiv.innerHTML = "";

  jobs.forEach((job, offset) => {
    const index = startIndex + offset;
    const card = document.createElement('div');
    card.className = 'job-card';
    card.id = `job-card-${index}`;

    let skillsHtml = "";
    if (job.matchedSkills && job.matchedSkills.length > 0) {
      skillsHtml = `<br>Matched Skills: ` + job.matchedSkills.map((skill) => `<span class="skills-tag">${escapeHtml(skill)}</span>`).join('');
    }

    const outsideLabel = job.platform === "LinkedIn" ? "below 5+ years" : "outside your range";
    const outsideRangeNote = job.experienceMatched === false
      ? ` <span style="color:#b45309;">(${outsideLabel})</span>`
      : "";
    const keywordNote = job.keywordMiss
      ? `<br><span style="color:#64748b;">Keyword not in the title. Shown because it is on this page.</span>`
      : "";
    const experienceHtml = job.experience
      ? `<br><span>Experience: <b>${escapeHtml(job.experience)}</b>${outsideRangeNote}</span>`
      : (job.experienceMatched === false ? `<br><span style="color:#b45309;">${escapeHtml(outsideLabel)}</span>` : "");
    const platformBadge = `<span style="background: #e2e8f0; color: #1e293b; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; float: right;">${escapeHtml(job.platform)}</span>`;

    card.innerHTML = `
      ${platformBadge}
      <strong>${index + 1}. ${escapeHtml(job.title)}</strong><br>
      <span>Company: <b>${escapeHtml(job.company)}</b></span>
      ${experienceHtml}<br>
      <span style="color: #d9534f; font-weight: bold;">Post Date: ${escapeHtml(job.postDate)}</span>
      ${skillsHtml}
      ${keywordNote}<br>
      <button class="apply-now-btn" data-id="job-card-${index}" data-link="${escapeHtml(job.link)}" data-title="${escapeHtml(job.title)}" data-company="${escapeHtml(job.company)}" data-postdate="${escapeHtml(job.postDate)}" data-platform="${escapeHtml(job.platform)}" style="margin-top:8px; padding:6px 12px; background:#28a745; font-size:12px; cursor:pointer; color:white; border:none; border-radius:4px;">Auto-Apply & Fill Form</button>
    `;
    scannedDiv.appendChild(card);
  });
}

document.getElementById('clearHistory').addEventListener('click', () => {
  if (confirm("Are you sure you want to clear applied history?")) {
    chrome.storage.local.set({ appliedHistory: [] }, () => {
      loadDashboardData();
    });
  }
});

document.getElementById('scannedList').addEventListener('click', (e) => {
  const button = e.target.closest('.apply-now-btn');
  if (!button) return;

  const cardId = button.getAttribute('data-id');
  const link = button.getAttribute('data-link');
  const title = button.getAttribute('data-title');
  const company = button.getAttribute('data-company');
  const postDate = button.getAttribute('data-postdate');
  const platform = button.getAttribute('data-platform');

  const cardElement = document.getElementById(cardId);
  if (cardElement) cardElement.remove();

  chrome.storage.local.get(['latestScan'], (res) => {
    if (!res.latestScan) return;
    const jobs = (res.latestScan.jobs || []).filter((job) => job.link !== link);
    chrome.storage.local.set({ latestScan: { ...res.latestScan, jobs } });
  });

  chrome.runtime.sendMessage({
    action: "execute_apply",
    link, title, company, postDate, platform
  }, () => {
    setTimeout(loadDashboardData, 500);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.latestScan) showLatestScan(changes.latestScan.newValue);
});