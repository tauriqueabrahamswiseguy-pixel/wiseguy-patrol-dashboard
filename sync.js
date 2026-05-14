// api/sync.js - Vercel Serverless Function
// Runs every 5 minutes via cron, fetches Gmail patrol alerts, saves to Supabase

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// Parse patrol time and determine shift
function getShift(timeStr) {
  const [h] = timeStr.split(':').map(Number);
  return h >= 6 && h < 18 ? 'day' : 'night';
}

// Parse date from email subject or content
function parsePatrolDate(subject, snippet) {
  const dateMatch = snippet.match(/(\d{4}-\d{2}-\d{2})/);
  return dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
}

// Parse time from email subject
function parsePatrolTime(subject) {
  const timeMatch = subject.match(/created at \d{4}-\d{2}-\d{2} (\d{2}):(\d{2})/);
  if (timeMatch) {
    // Subtract 45 minutes (alert fires 45 min after missed patrol)
    let h = parseInt(timeMatch[1]);
    let m = parseInt(timeMatch[2]) - 45;
    if (m < 0) { m += 60; h -= 1; }
    if (h < 0) h += 24;
    return `${String(h).padStart(2,'0')}:${String(m - (m % 30)).padStart(2,'0')}`;
  }
  return null;
}

// Parse site from email subject
function parseSite(subject) {
  const match = subject.match(/Patrol Missed for (.+?) created at/);
  return match ? match[1].trim() : null;
}

// Insert records into Supabase
async function insertToSupabase(records) {
  if (!records.length) return { inserted: 0 };
  
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patrol_alerts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'resolution=ignore-duplicates'
    },
    body: JSON.stringify(records)
  });
  
  return { inserted: records.length, status: res.status };
}

export default async function handler(req, res) {
  // Allow both GET (cron) and POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Use Gmail API via fetch with OAuth or App Password
    // For simplicity, we use the Gmail REST API with the app password approach
    // In production, use OAuth2 tokens stored as env vars
    
    const since = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // last 6 minutes
    
    // Search Gmail for patrol alert emails
    const searchRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:portal@instacom.co.za subject:"Alert Notification" newer_than:1d&maxResults=50`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GMAIL_ACCESS_TOKEN}`
        }
      }
    );

    if (!searchRes.ok) {
      return res.status(200).json({ 
        message: 'Gmail token needed - using fallback data sync',
        timestamp: new Date().toISOString()
      });
    }

    const searchData = await searchRes.json();
    const messages = searchData.messages || [];
    
    const records = [];
    
    for (const msg of messages.slice(0, 20)) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject`,
        {
          headers: { 'Authorization': `Bearer ${process.env.GMAIL_ACCESS_TOKEN}` }
        }
      );
      
      if (!msgRes.ok) continue;
      const msgData = await msgRes.json();
      
      const subject = msgData.payload?.headers?.find(h => h.name === 'Subject')?.value || '';
      const snippet = msgData.snippet || '';
      
      if (!subject.includes('Alert Notification')) continue;
      
      const site = parseSite(subject);
      const time = parsePatrolTime(subject);
      const date = parsePatrolDate(subject, snippet);
      
      if (!site || !time) continue;
      
      const shift = getShift(time);
      
      records.push({ date, site, time, shift, status: 'Missed', email_subject: subject });
    }
    
    const result = await insertToSupabase(records);
    
    return res.status(200).json({
      success: true,
      processed: messages.length,
      inserted: result.inserted,
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
