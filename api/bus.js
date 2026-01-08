export default async function handler(req, res) {
  try {
    const stopId = (req.query.stop_id || "").toString().trim()
    const secondaryStopId = (req.query.secondary_stop_id || "").toString().trim()

    if (!stopId) {
      return res.status(400).json({ error: "Missing stop_id" })
    }

    const TMB_APP_ID = process.env.TMB_APP_ID
    const TMB_APP_KEY = process.env.TMB_APP_KEY

    if (!TMB_APP_ID || !TMB_APP_KEY) {
      return res.status(500).json({ error: "Server missing TMB credentials" })
    }

    const stopsToFetch = [stopId]
    if (secondaryStopId) stopsToFetch.push(secondaryStopId)

    const results = await Promise.all(
      stopsToFetch.map(async (sid) => {
        const url = new URL(`https://api.tmb.cat/v1/ibus/stops/${encodeURIComponent(sid)}`)
        url.searchParams.set("app_id", TMB_APP_ID)
        url.searchParams.set("app_key", TMB_APP_KEY)

        const r = await fetch(url.toString(), { headers: { accept: "application/json" } })

        if (!r.ok) {
          return { stop_id: sid, error: `TMB error ${r.status}`, departures: [] }
        }

        const payload = await r.json()

        // TMB responses sometimes vary in shape, try a few paths
        const ibus =
          payload?.data?.ibus ??
          payload?.data?.["ibus"] ??
          payload?.data?.["iBus"] ??
          payload?.data?.["i-bus"] ??
          payload?.ibus ??
          []

        const departures = (Array.isArray(ibus) ? ibus : [])
          .slice(0, 6)
          .map((d) => {
            const rawMinutes =
              d?.t_in_min ??
              d?.["t-in-min"] ??
              d?.t_in_minute ??
              d?.["t-in-minute"] ??
              d?.minutes ??
              d?.["minutes"]

            const minutes = Number.isFinite(Number(rawMinutes)) ? Number(rawMinutes) : null

            return {
              line: (d?.line || "").toString(),
              destination: (d?.destination || "").toString(),
              minutes,
            }
          })
          .filter((d) => d.line && d.destination)

        return { stop_id: sid, departures }
      })
    )

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60")

    return res.status(200).json({
      title: "Barcelona buses",
      updated_at: new Date().toISOString(),
      stops: results,
    })
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error" })
  }
}
