/**
 * Phase 2 shadow-mode dev script (plan/hybrid-rule-engine-scheduling.md).
 *
 * Takes an already-generated (real LLM) itinerary from the dev DB — no new
 * OpenAI/Google Places calls, so this costs nothing to run — picks one
 * city's block of sightseeing days, pools together every real stop + meal
 * across that block as a synthetic candidate pool, then asks the rule
 * engine (buildDaySkeleton) to independently pick+order+schedule each day
 * from that same pool. Prints a side-by-side diff for manual spot-checking:
 * how much the rule engine's picks overlap with what the LLM actually
 * chose for that day, and how the two time_of_day distributions compare.
 *
 * This is a calibration tool, not a test — there's no "correct" answer to
 * assert against, only a report to read (see plan section 5, Phase 2).
 *
 * Usage:
 *   npx tsx scripts/shadow-compare-scheduler.ts [itineraryId] [cityName]
 *   - itineraryId: defaults to the most recently created itinerary.
 *   - cityName: defaults to the city with the most sightseeing days.
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildDaySkeleton } from "@/lib/scheduler/buildDaySkeleton";
import type { StopCandidate } from "@/lib/scheduler/selectAndOrderStops";
import { MEAL_TYPES, type Day, type Stop } from "@/types/itinerary";

try {
  const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {}

const prisma = new PrismaClient();

function hasCoords(v: { lat?: number | null; lng?: number | null }): v is { lat: number; lng: number } {
  return typeof v.lat === "number" && typeof v.lng === "number";
}

function candidateId(place: { placeId?: string; name: string }): string {
  return place.placeId ?? `name:${place.name}`;
}

function stopToCandidate(stop: Stop): StopCandidate | null {
  if (!hasCoords(stop)) return null;
  return { id: candidateId(stop), lat: stop.lat, lng: stop.lng, rating: stop.rating ?? undefined };
}

async function main() {
  const itineraryId = process.argv[2];
  const requestedCity = process.argv[3];

  const itineraryRow = itineraryId
    ? await prisma.itinerary.findUnique({ where: { id: itineraryId } })
    : await prisma.itinerary.findFirst({ orderBy: { createdAt: "desc" } });

  if (!itineraryRow) {
    console.error("No itinerary found. Run `npm run seed` first, or pass an itineraryId.");
    process.exit(1);
  }

  const days = JSON.parse(itineraryRow.days) as Day[];
  console.log(`\nItinerary: "${itineraryRow.title}" (${itineraryRow.id}), ${days.length} days\n`);

  const sightseeingDays = days.filter((d) => !d.isTransitDay && !d.isLocked && d.waypointCity);

  const cityCounts = new Map<string, number>();
  for (const d of sightseeingDays) {
    const city = d.waypointCity!;
    cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1);
  }

  const targetCity =
    requestedCity ??
    [...cityCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  if (!targetCity) {
    console.error("No sightseeing-day city block found in this itinerary.");
    process.exit(1);
  }

  const cityDays = sightseeingDays.filter((d) => d.waypointCity === targetCity);
  console.log(`City block: ${targetCity} (${cityDays.length} sightseeing day(s))\n`);

  // Pool every real stop + meal across the whole city block — the rule
  // engine picks from this shared pool independently per day, same as the
  // plan's "同一批候選池" shadow-mode setup.
  const poolById = new Map<string, StopCandidate>();
  for (const day of cityDays) {
    for (const stop of day.stops) {
      const candidate = stopToCandidate(stop);
      if (candidate) poolById.set(candidate.id, candidate);
    }
    for (const mealType of MEAL_TYPES) {
      const meal = day.meals?.[mealType];
      if (meal && hasCoords(meal)) {
        poolById.set(candidateId(meal), {
          id: candidateId(meal),
          lat: meal.lat,
          lng: meal.lng,
          rating: meal.rating ?? undefined,
          type: mealType,
        });
      }
    }
  }
  const candidatePool = [...poolById.values()];
  console.log(`Candidate pool: ${candidatePool.length} unique real places\n`);

  const overlapRates: number[] = [];

  for (const day of cityDays) {
    const realStopIds = new Set(day.stops.map(candidateId));
    const realMealIds = new Set(
      MEAL_TYPES.map((t) => day.meals?.[t]).filter((m): m is NonNullable<typeof m> => m != null).map(candidateId)
    );
    const realIds = new Set([...realStopIds, ...realMealIds]);
    const count = realIds.size;
    if (count === 0) continue;

    const origin = hasCoords(day.accommodation ?? {}) ? (day.accommodation as { lat: number; lng: number }) : undefined;

    const skeleton = buildDaySkeleton(candidatePool, {
      count,
      pace: "moderate",
      origin,
      mealTypes: [...MEAL_TYPES],
    });

    const skeletonIds = new Set(skeleton.map((s) => s.id));
    const overlap = [...skeletonIds].filter((id) => realIds.has(id)).length;
    const overlapRate = overlap / count;
    overlapRates.push(overlapRate);

    // Meals have no time_of_day of their own in the stored data model, so
    // this distribution only reflects the sightseeing-stop subset of each
    // side's picks — not the full stops+meals count above.
    const realTimeOfDayCounts = countTimeOfDay(day.stops.map((s) => s.time_of_day));
    const ruleTimeOfDayCounts = countTimeOfDay(skeleton.map((s) => s.time_of_day));

    console.log(`Day ${day.day} (theme: ${day.theme ?? "-"})`);
    console.log(
      `  real:        ${count} picks (${realStopIds.size} stops + ${realMealIds.size} meals), stop time_of_day ${formatCounts(realTimeOfDayCounts)}`
    );
    console.log(
      `  rule engine: ${skeleton.length} picks, time_of_day ${formatCounts(ruleTimeOfDayCounts)}`
    );
    console.log(`  overlap with LLM's actual picks: ${overlap}/${count} (${(overlapRate * 100).toFixed(0)}%)\n`);
  }

  if (overlapRates.length > 0) {
    const avg = overlapRates.reduce((a, b) => a + b, 0) / overlapRates.length;
    console.log(`Average pick overlap across ${overlapRates.length} day(s): ${(avg * 100).toFixed(0)}%`);
  }
}

function countTimeOfDay(values: (string | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = { morning: 0, afternoon: 0, evening: 0, unknown: 0 };
  for (const v of values) {
    if (v === "morning" || v === "afternoon" || v === "evening") counts[v]++;
    else counts.unknown++;
  }
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  return `morning=${counts.morning} afternoon=${counts.afternoon} evening=${counts.evening}${
    counts.unknown ? ` unknown=${counts.unknown}` : ""
  }`;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
