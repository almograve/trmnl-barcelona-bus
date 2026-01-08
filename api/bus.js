export default async function handler(req, res) {
  try {
    const stopId = (req.query.stop_id || "").toString().trim()
    const secondaryStopId = (req.query.secondary_stop_id || "").toString().trim()
    const debug = (req.query.debug || "").toString().trim() === "1"
    const prefer = (req.query.prefer || "").toString().trim() // "web" or "official"

    if (!stopId) {
      return res.status(400).json({ error: "Missing stop_id" })
    }

    const TMB_APP_ID = process.env.TMB_APP_ID
    const TMB_APP_KEY = process.env.TMB_APP_KEY
    const hasOfficialCreds = Boolean(TMB_APP_ID && TMB_APP_KEY)

    const uniqSorted = (arr) => Array.from(new Set(arr)).sort((a, b) => a - b)

    const groupTimesByLine = (rows, maxLines) => {
      const byLine = new Map()

      for (const r of rows) {
        const line = (r.line || "").toString().trim()
        const destination = (r.destination || "").toString().trim()
        const minutes = r.minutes

        if (!line || !destination) continue
        if (!Number.isFinite(minutes)) continue

        if (!byLine.has(line)) byLine.set(line, { line, destination, mins: [] })
        byLine.get(line).mins.push(minutes)
      }

      const lines = Array.from(byLine.values())
        .map((x) => {
          const mins = uniqSorted(x.mins)
          return {
            line: x.line,
            destination: x.destination,
            m1: mins[0] ?? null,
            m2: mins[1] ?? null,
          }
        })
        .sort((a, b) => (a.m1 ?? 9999) - (b.m1 ?? 9999))
        .slice(0, maxLines)

      return lines
    }

    const fetchStopFromWebFeed = async (sid) => {
      const url =
        "https://www.tmb.cat/en/barcelona/tmb-ibus/next-bus" +
        "?_buslineportlet_cmd=BUS_TIME_STOPS_AMB" +
        "&_buslineportlet_groupId=20182" +
        "&_buslineportlet_ibus=1" +
        "&_buslineportlet_renderPage=view-bus-stop-line" +
        `&_buslineportlet_stopName=${encodeURIComponent(sid)}` +
        "&p_p_cacheability=cacheLevelPage" +
        "&p_p_id=buslineportlet" +
        "&p_p_lifecycle=2" +
        "&p_p_mode=view" +
        "&p_p_state=normal"

      const headers = {
        accept: "application/json,text/plain,*/*",
        "accept-language": "en-GB,en;q=0.9,es;q=0.8,ca;q=0.7",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        referer: `https://www.tmb.cat/en/barcelona/tmb-ibus/next-bus/-/lineabus/parada/${encodeURIComponent(sid)}`,
      }

      let text = ""
      try {
        const r = await fetch(url, { headers })
        text = await r.text()

        if (!r.ok) {
          return {
            ok: false,
            status: r.status,
            lines: [],
            debug: { url, snippet: text.slice(0, 280) },
          }
        }

        let payload = null
        try {
          payload = JSON.parse(text)
        } catch {
          return {
            ok: false,
            status: 200,
            lines: [],
            debug: { url, snippet: text.slice(0, 280), note: "not_json" },
          }
        }

        const times = Array.isArray(payload?.times) ? payload.times : []

        const rows = []
        for (const t of times) {
          const line = (t?.lineCode || "").toString().trim()
          const destination = (t?.destination || "").toString().trim()
          const arrivalSec = Number(t?.arrivalTime)

          if (!line || !destination) continue
          if (!Number.isFinite(arrivalSec)) continue

          const minutes = Math.max(0, Math.round(arrivalSec / 60))
          rows.push({ line, destination, minutes })
        }

        const lines = groupTimesByLine(rows, 12)

        return {
          ok: true,
          status: 200,
          lines,
          debug: debug
            ? { url, times_count: times.length, keys: payload ? Object.keys(payload).slice(0, 20) : [] }
            : undefined,
        }
      } catch (e) {
        return {
          ok: false,
          status: 0,
          lines: [],
          debug: { url, note: "fetch_failed", snippet: text.slice(0, 280) },
        }
      }
    }

    const parseOfficialMinutes = (d) => {
      const raw =
        d?.t_in_min ??
        d?.["t-in-min"] ??
        d?.t_in_minute ??
        d?.["t-in-minute"] ??
        d?.minutes ??
        d?.["minutes"]

      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }

    const normalizeOfficialIbusArray = (payload) => {
      const ibus =
        payload?.data?.ibus ??
        payload?.data?.["ibus"] ??
        payload?.data?.["iBus"] ??
        payload?.data?.["i-bus"] ??
        payload?.ibus ??
        []

      return Array.isArray(ibus) ? ibus : []
    }

    const fetchStopFromOfficialApi = async (sid) => {
      if (!hasOfficialCreds) {
        return { ok: false, status: 500, lines: [], debug: { note: "official_missing_creds" } }
      }

      const url = new URL(`https://api.tmb.cat/v1/ibus/stops/${encodeURIComponent(sid)}`)
      url.searchParams.set("app_id", TMB_APP_ID)
      url.searchParams.set("app_key", TMB_APP_KEY)

      const r = await fetch(url.toString(), { headers: { accept: "application/json" } })
      if (!r.ok) {
        return { ok: false, status: r.status, lines: [], debug: debug ? { url: url.toString() } : undefined }
      }

      const payload = await r.json()
      const ibus = normalizeOfficialIbusArray(payload)

      const rows = []
      for (const d of ibus) {
        const line = (d?.line || "").toString().trim()
        const destination = (d?.destination || "").toString().trim()
        const minutes = parseOfficialMinutes(d)

        if (!line || !destination) continue
        if (!Number.isFinite(minutes)) continue

        rows.push({ line, destination, minutes })
      }

      const lines = groupTimesByLine(rows, 12)
      return { ok: true, status: 200, lines }
    }

    const fetchStop = async (sid) => {
      const web = await fetchStopFromWebFeed(sid)
      const official = await fetchStopFromOfficialApi(sid)

      const chooseWeb =
        prefer === "web" ||
        (prefer !== "official" && web.ok && web.lines.length > 0)

      const chooseOfficial =
        prefer === "official" ||
        (prefer !== "web" && official.ok && official.lines.length > 0)

      if (chooseWeb) {
        return { stop_id: sid, lines: web.lines, source: "web", web_debug: debug ? web.debug : undefined }
      }

      if (chooseOfficial) {
        return { stop_id: sid, lines: official.lines, source: "official", web_debug: debug ? web.debug : undefined }
      }

      return {
        stop_id: sid,
        lines: [],
        error: "No upcoming buses",
        source: "none",
        web_debug: debug ? web.debug : undefined,
      }
    }

    const stops = []
    stops.push(await fetchStop(stopId))
    if (secondaryStopId) stops.push(await fetchStop(secondaryStopId))

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60")

    return res.status(200).json({
      title: "Barcelona buses",
      updated_at: new Date().toISOString(),
      stops,
    })
  } catch {
    return res.status(500).json({ error: "Unexpected error" })
  }
}
