export default async function handler(req, res) {
  try {
    const stopId = (req.query.stop_id || "").toString().trim()
    const secondaryStopId = (req.query.secondary_stop_id || "").toString().trim()

    if (!stopId) return res.status(400).json({ error: "Missing stop_id" })

    const TMB_APP_ID = process.env.TMB_APP_ID
    const TMB_APP_KEY = process.env.TMB_APP_KEY
    if (!TMB_APP_ID || !TMB_APP_KEY) {
      return res.status(500).json({ error: "Server missing TMB credentials" })
    }

    const nowMs = () => Date.now()

    const minutesUntil = (arrivalMs) => {
      const diff = Math.round((Number(arrivalMs) - nowMs()) / 60000)
      return Number.isFinite(diff) ? Math.max(0, diff) : null
    }

    const uniqSorted = (arr) => Array.from(new Set(arr)).sort((a, b) => a - b)

    const buildLinesFromDepartures = (deps, maxLines) => {
      const byLine = new Map()

      for (const d of deps) {
        if (!d.line || !d.destination || d.minutes === null) continue
        if (!byLine.has(d.line)) byLine.set(d.line, { line: d.line, destination: d.destination, mins: [] })
        byLine.get(d.line).mins.push(d.minutes)
      }

      return Array.from(byLine.values())
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
    }

    const fetchStop = async (sid) => {
      const url = new URL(`https://api.tmb.cat/v1/itransit/bus/parades/${encodeURIComponent(sid)}`)
      url.searchParams.set("agrupar_desti", "true")
      url.searchParams.set("numberOfPredictions", "2")
      url.searchParams.set("app_id", TMB_APP_ID)
      url.searchParams.set("app_key", TMB_APP_KEY)

      const r = await fetch(url.toString(), { headers: { accept: "application/json" } })
      if (!r.ok) return { stop_id: sid, error: `TMB error ${r.status}`, departures: [], lines: [] }

      const payload = await r.json()

      const parades = Array.isArray(payload?.parades) ? payload.parades : []
      const parada = parades.find((p) => (p?.codi_parada || "").toString() === sid.toString()) || parades[0]

      const linies = Array.isArray(parada?.linies_trajectes) ? parada.linies_trajectes : []

      const departures = []
      for (const lt of linies) {
        const line = (lt?.nom_linia || "").toString().trim()
        const destination = (lt?.desti_trajecte || "").toString().trim()
        const buses = Array.isArray(lt?.propers_busos) ? lt.propers_busos : []

        for (const b of buses) {
          const arrivalMs = b?.temps_arribada
          const minutes = minutesUntil(arrivalMs)
          if (!line || !destination || minutes === null) continue
          departures.push({ line, destination, minutes })
        }
      }

      departures.sort((a, b) => a.minutes - b.minutes)

      const lines = buildLinesFromDepartures(departures, 12)

      return { stop_id: sid.toString(), departures: departures.slice(0, 40), lines }
    }

    const stops = [await fetchStop(stopId)]
    if (secondaryStopId) stops.push(await fetchStop(secondaryStopId))

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45")
    return res.status(200).json({
      title: "Barcelona buses",
      updated_at: new Date().toISOString(),
      stops,
    })
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error" })
  }
}
