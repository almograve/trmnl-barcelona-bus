export default async function handler(req, res) {
  try {
    const stopId = (req.query.stop_id || "").toString().trim()
    const secondaryStopId = (req.query.secondary_stop_id || "").toString().trim()

    if (!stopId) return res.status(400).json({ error: "Missing stop_id" })

    const TMB_APP_ID = process.env.TMB_APP_ID
    const TMB_APP_KEY = process.env.TMB_APP_KEY
    if (!TMB_APP_ID || !TMB_APP_KEY) return res.status(500).json({ error: "Server missing TMB credentials" })

    const TZ = "Europe/Madrid"

    const fmtHHMM = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })

    const nowMs = () => Date.now()

    const minutesUntil = (arrivalMs) => {
      const n = Number(arrivalMs)
      if (!Number.isFinite(n)) return null
      const diff = Math.round((n - nowMs()) / 60000)
      if (!Number.isFinite(diff)) return null
      return Math.max(0, diff)
    }

    const toHHMM = (ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n)) return null
      return fmtHHMM.format(new Date(n))
    }

    const uniqSorted = (arr) => Array.from(new Set(arr)).sort((a, b) => a - b)

    const buildLinesFromDepartures = (deps, maxLines) => {
      const byLine = new Map()

      for (const d of deps) {
        if (!d.line || !d.destination) continue
        if (d.minutes === null || d.arrival_ms === null) continue

        if (!byLine.has(d.line)) {
          byLine.set(d.line, { line: d.line, destination: d.destination, mins: [], arrs: [] })
        }
        const obj = byLine.get(d.line)
        obj.mins.push(d.minutes)
        obj.arrs.push(Number(d.arrival_ms))
      }

      return Array.from(byLine.values())
        .map((x) => {
          const mins = uniqSorted(x.mins)
          const arrs = uniqSorted(x.arrs)
          const t1_ms = arrs[0] ?? null
          const t2_ms = arrs[1] ?? null

          return {
            line: x.line,
            destination: x.destination,
            m1: mins[0] ?? null,
            m2: mins[1] ?? null,
            t1_ms,
            t2_ms,
            t1_local: t1_ms ? toHHMM(t1_ms) : null,
            t2_local: t2_ms ? toHHMM(t2_ms) : null,
          }
        })
        .sort((a, b) => (a.m1 ?? 9999) - (b.m1 ?? 9999))
        .slice(0, maxLines)
    }

    const fetchStop = async (sid) => {
      const url = new URL(`https://api.tmb.cat/v1/itransit/bus/parades/${encodeURIComponent(sid)}`)
      url.searchParams.set("agrupar_desti", "true")
      url.searchParams.set("numberOfPredictions", "2")
      url.searchParams.set("app_id", TMB_APP_ID)
      url.searchParams.set("app_key", TMB_APP_KEY)

      const r = await fetch(url.toString(), { headers: { accept: "application/json" } })
      if (!r.ok) {
        return {
          stop_id: sid.toString(),
          departures: [],
          lines: [],
          stop_detail: { stop_id: sid.toString(), name: null, api_timestamp_ms: null, ramp_ko_count: 0, ramp_ko_examples: [] },
          error: `TMB error ${r.status}`,
        }
      }

      const payload = await r.json()

      const apiTimestamp = Number(payload?.timestamp)
      const parades = Array.isArray(payload?.parades) ? payload.parades : []
      const parada = parades.find((p) => (p?.codi_parada || "").toString() === sid.toString()) || parades[0] || null

      const stopName = (parada?.nom_parada || "").toString().trim() || null
      const linies = Array.isArray(parada?.linies_trajectes) ? parada.linies_trajectes : []

      const departures = []
      const rampKO = []

      for (const lt of linies) {
        const line = (lt?.nom_linia || "").toString().trim()
        const destination = (lt?.desti_trajecte || "").toString().trim()
        const buses = Array.isArray(lt?.propers_busos) ? lt.propers_busos : []

        for (const b of buses) {
          const arrivalMs = Number(b?.temps_arribada)
          const minutes = minutesUntil(arrivalMs)
          const arrivalLocal = Number.isFinite(arrivalMs) ? toHHMM(arrivalMs) : null

          if (line && destination && minutes !== null && Number.isFinite(arrivalMs)) {
            departures.push({ line, destination, minutes, arrival_ms: arrivalMs, arrival_local: arrivalLocal })
          }

          const ramp = b?.info_bus?.accessibilitat?.estat_rampa
          if (ramp === "KO") rampKO.push({ line, destination })
        }
      }

      departures.sort((a, b) => a.minutes - b.minutes)

      const lines = buildLinesFromDepartures(departures, 12)

      const stop_detail = {
        stop_id: sid.toString(),
        name: stopName,
        api_timestamp_ms: Number.isFinite(apiTimestamp) ? apiTimestamp : null,
        ramp_ko_count: rampKO.length,
        ramp_ko_examples: rampKO.slice(0, 2),
      }

      return { stop_id: sid.toString(), departures: departures.slice(0, 40), lines, stop_detail }
    }

    const stops = [await fetchStop(stopId)]
    if (secondaryStopId) stops.push(await fetchStop(secondaryStopId))

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45")
    return res.status(200).json({
      title: "Barcelona buses",
      updated_at: new Date().toISOString(),
      updated_local: toHHMM(Date.now()),
      stops,
    })
  } catch {
    return res.status(500).json({ error: "Unexpected error" })
  }
}
