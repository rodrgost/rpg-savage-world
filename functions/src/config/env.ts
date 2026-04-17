import 'dotenv/config'

export const env = {
  summaryIntervalTurns: Number(process.env.SUMMARY_INTERVAL_TURNS ?? '10')
}
