
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query, limitToLast
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

// Firebase configuration
const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "solar-agarbatti-monitor.firebaseapp.com",
  databaseURL: "https://solar-agarbatti-monitor-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "solar-agarbatti-monitor",
  storageBucket: "PASTE_YOUR_STORAGE_BUCKET",
  messagingSenderId: "PASTE_YOUR_MESSAGING_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};

// ESP32 and Firebase paths
const DEVICE_ID = "ESP32_AGARBATTI_01";
const CURRENT_PATH = `devices/${DEVICE_ID}/current`;
const HISTORY_PATH = `devices/${DEVICE_ID}/history`;

const $ = id => document.getElementById(id);

let database;
let chart;
let demoMode = false;
let currentUnsubscribe = null;
let historyUnsubscribe = null;
let toastTimer;

// Convert ESP32 ON/OFF, true/false, 1/0 into a consistent state
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    if (["on", "true", "1", "yes"].includes(v)) return true;
    if (["off", "false", "0", "no"].includes(v)) return false;
  }

  return null;
}

function getValue(data, keys) {
  for (const key of keys) {
    if (data?.[key] !== undefined && data[key] !== null) {
      return data[key];
    }
  }
  return null;
}

function normalize(data, key = "") {
  if (!data || typeof data !== "object") return null;

  const t = getValue(data, ["temperature", "temp"]);
  const h = getValue(data, ["humidity", "hum"]);

  return {
    key,
    temperature: t !== null && Number.isFinite(Number(t))
      ? Number(t) : null,
    humidity: h !== null && Number.isFinite(Number(h))
      ? Number(h) : null,
    ldr: getValue(data, ["ldr", "ldrValue", "light"]),
    fan: toBoolean(getValue(data, ["fan", "fanState"])),
    lamp: toBoolean(getValue(data, ["lamp", "lampState"])),
    buzzer: toBoolean(getValue(data, ["buzzer", "buzzerState"])),
    timestamp: getValue(data, ["timestamp", "time", "ts"])
  };
}

function timeText(value) {
  if (value === null || value === undefined) return "Time unavailable";

  let n = Number(value);
  let date;

  if (Number.isFinite(n) && String(value).trim() !== "") {
    if (n < 1e12) n *= 1000;
    date = new Date(n);
  } else {
    date = new Date(value);
  }

  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleString();
}

function setConnection(status, message) {
  const el = $("connection");
  el.className = "connection";
  if (status === "connected") el.classList.add("connected");
  if (status === "error") el.classList.add("error");

  el.innerHTML = `<i class="dot"></i>${message}`;
  $("cloudHealth").textContent = message;
  $("sideStatus").textContent = message;
}

function showNotice(message, type = "") {
  $("notice").textContent = message;
  $("notice").className = "notice " + type;
}

function showToast(message) {
  // Simple browser notification fallback
  let toast = $("notice");
  toast.textContent = message;
  toast.className = "notice warning";
  clearTimeout(toastTimer);
}

function stateText(value) {
  return value === null ? "UNKNOWN" : value ? "ON" : "OFF";
}

function renderCurrent(r) {
  if (!r) {
    $("lastUpdate").textContent = "Waiting for ESP32...";
    $("sensorHealth").textContent = "Waiting";
    showNotice(
      `No current record yet. Waiting for ESP32 at /${CURRENT_PATH}.`,
      "warning"
    );
    return;
  }

  $("temperature").textContent =
    r.temperature === null ? "—" : r.temperature.toFixed(1);

  $("humidity").textContent =
    r.humidity === null ? "—" : r.humidity.toFixed(1);

  $("ldr").textContent = r.ldr === null ? "—" : String(r.ldr);
  $("fan").textContent = stateText(r.fan);
  $("lamp").textContent = stateText(r.lamp);
  $("buzzer").textContent = stateText(r.buzzer);

  $("lastUpdate").textContent = timeText(r.timestamp);

  $("tempHint").textContent =
    r.temperature !== null && r.temperature >= 60
      ? "HIGH TEMPERATURE WARNING"
      : "Latest sensor reading";

  $("tempHealth").textContent =
    r.temperature === null ? "Unknown"
      : r.temperature >= 60 ? "HIGH" : "Normal";

  $("tempHealth").className =
    r.temperature !== null && r.temperature >= 60 ? "bad" : "good";

  $("sensorHealth").textContent =
    r.temperature !== null && r.humidity !== null
      ? "Receiving" : "Partial data";

  $("sensorHealth").className =
    r.temperature !== null && r.humidity !== null ? "good" : "bad";

  const alert = $("alertBox");

  if (r.temperature !== null && r.temperature >= 60) {
    alert.className = "alert-box danger";
    alert.textContent =
      `High temperature: ${r.temperature.toFixed(1)}°C. Check the chamber.`;
  } else if (r.temperature === null || r.humidity === null) {
    alert.className = "alert-box warning";
    alert.textContent = "Temperature or humidity data is missing.";
  } else {
    alert.className = "alert-box";
    alert.textContent = "No active temperature warning.";
  }

  if (!demoMode) {
    showNotice(
      `Live Firebase data received from /${CURRENT_PATH}.`,
      "success"
    );
  }
}

function timestampMs(value) {
  if (value === null || value === undefined) return 0;

  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== "") {
    return n < 1e12 ? n * 1000 : n;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function renderHistory(records) {
  // Latest records first in the table
  records.sort(
    (a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp)
  );

  const visible = records.slice(0, 100);
  $("recordCount").textContent = `${records.length} records`;
  $("recordSummary").textContent = `${visible.length} records loaded`;

  const tbody = $("historyTable");

  if (!visible.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="empty">No historical records saved yet.</td></tr>';
  } else {
    tbody.innerHTML = visible.map(r => `
      <tr>
        <td>${escapeHtml(timeText(r.timestamp))}</td>
        <td>${r.temperature === null ? "—" : r.temperature.toFixed(1) + " °C"}</td>
        <td>${r.humidity === null ? "—" : r.humidity.toFixed(1) + " %"}</td>
        <td>${escapeHtml(r.ldr ?? "—")}</td>
        <td>${stateText(r.fan)}</td>
        <td>${stateText(r.lamp)}</td>
        <td>${stateText(r.buzzer)}</td>
      </tr>
    `).join("");
  }

  renderChart(records);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function renderChart(records) {
  if (!window.Chart) return;

  // Plot up to the latest 50 records in chronological order
  const data = records.slice(0, 50).sort(
    (a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp)
  );

  if (chart) chart.destroy();

  chart = new Chart($("historyChart"), {
    type: "line",
    data: {
      labels: data.map(r => {
        const ms = timestampMs(r.timestamp);
        return ms
          ? new Date(ms).toLocaleTimeString([], {
              hour: "2-digit", minute: "2-digit"
            })
          : "—";
      }),
      datasets: [
        {
          label: "Temperature (°C)",
          data: data.map(r => r.temperature),
          borderColor: "#e58a2d",
          backgroundColor: "#e58a2d18",
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.3,
          spanGaps: true
        },
        {
          label: "Humidity (%)",
          data: data.map(r => r.humidity),
          borderColor: "#2879d8",
          backgroundColor: "#2879d818",
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.3,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom" }
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: false }
      }
    }
  });
}

function stopListeners() {
  if (currentUnsubscribe) currentUnsubscribe();
  if (historyUnsubscribe) historyUnsubscribe();
  currentUnsubscribe = null;
  historyUnsubscribe = null;
}

function connectFirebase() {
  if (
    firebaseConfig.apiKey === "PASTE_YOUR_API_KEY" ||
    firebaseConfig.appId === "PASTE_YOUR_APP_ID" ||
    firebaseConfig.messagingSenderId === "PASTE_YOUR_MESSAGING_SENDER_ID"
  ) {
    setConnection("error", "Web config required");
    showNotice(
      "Add the Firebase Web App config from Project Overview → Add app → Web. The database URL is already filled in.",
      "warning"
    );
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    database = getDatabase(app);

    setConnection("waiting", "Connecting...");

    currentUnsubscribe = onValue(
      ref(database, CURRENT_PATH),
      snapshot => {
        setConnection("connected", "Firebase connected");

        if (!snapshot.exists()) {
          renderCurrent(null);
          return;
        }

        renderCurrent(normalize(snapshot.val()));
      },
      error => {
        console.error("Current data read failed:", error);
        setConnection("error", "Read denied");
        showNotice(
          `Firebase current data error: ${error.message}. Check authentication and database rules.`,
          "warning"
        );
      }
    );

    const historyRef = query(
      ref(database, HISTORY_PATH),
      limitToLast(500)
    );

    historyUnsubscribe = onValue(
      historyRef,
      snapshot => {
        const records = [];

        if (snapshot.exists()) {
          snapshot.forEach(child => {
            const record = normalize(child.val(), child.key);
            if (record) records.push(record);
          });
        }

        renderHistory(records);
      },
      error => {
        console.error("History read failed:", error);
        showToast(
          "History could not be read. Check Firebase rules and history path."
        );
      }
    );
  } catch (error) {
    console.error(error);
    setConnection("error", "Configuration error");
    showNotice(error.message, "warning");
  }
}

// Demo mode for preview only. These readings are not from the hardware.
function toggleDemo() {
  demoMode = !demoMode;
  stopListeners();

  if (!demoMode) {
    $("demoButton").textContent = "Enable Demo";
    connectFirebase();
    return;
  }

  $("demoButton").textContent = "Exit Demo";
  setConnection("waiting", "DEMO MODE");
  showNotice(
    "DEMO MODE — simulated readings only; not real ESP32 data.",
    "warning"
  );

  const now = Date.now();
  renderCurrent(normalize({
    temperature: 42.5,
    humidity: 38.2,
    ldr: 1,
    fan: true,
    lamp: false,
    buzzer: false,
    timestamp: now
  }));

  const samples = Array.from({ length: 18 }, (_, i) =>
    normalize({
      temperature: 38 + Math.sin(i / 3) * 5 + i * 0.15,
      humidity: 44 - Math.sin(i / 3) * 7,
      ldr: i % 2,
      fan: i > 5,
      lamp: i % 4 === 0,
      buzzer: false,
      timestamp: now - (17 - i) * 60000
    })
  );

  renderHistory(samples);
}

$("demoButton").addEventListener("click", toggleDemo);

$("refreshButton").addEventListener("click", () => {
  if (demoMode) {
    showToast("Demo readings are simulated.");
  } else {
    showToast("Realtime listeners refresh automatically.");
  }
});

window.addEventListener("beforeunload", stopListeners);

connectFirebase();
