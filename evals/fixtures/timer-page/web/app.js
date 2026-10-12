// Renders the timers the team keeps. loadTimers() resolves to [{ name, ms }] and rejects when the store cannot be read.
async function loadTimers() {
  const response = await fetch("timers.json");
  if (!response.ok) throw new Error(`timers: ${response.status}`);
  return response.json();
}

function label(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

async function render() {
  const list = document.getElementById("timers");
  const timers = await loadTimers();
  list.innerHTML = "";
  for (const timer of timers) {
    const item = document.createElement("li");
    item.className = "row";
    item.textContent = `${timer.name} — ${label(timer.ms)}`;
    list.appendChild(item);
  }
}

document.getElementById("add").addEventListener("click", () => window.alert("Add timer: not built yet"));
render();
