import { authenticate } from "../shopify.server";
import { getBatchRecord } from "../models/bulkBatch.server";
import { getProgress, getCsvContent } from "../models/bulkJobProgress.server";

// Random per-process ID, generated once when this process starts.
// If different polls for the same batch return different values here,
// that proves you have multiple server processes with separate memory.
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

export const loader = async ({ request, params }) => {
  const inMemoryProgress = getProgress(params.batchId);

  if (inMemoryProgress) {
    return Response.json({
      progress: inMemoryProgress,
      csvContent: inMemoryProgress.status === "complete" ? getCsvContent(params.batchId) : null,
      _debug: { instanceId: INSTANCE_ID, source: "in-memory" },
    });
  }

  try {
    const { admin } = await authenticate.admin(request);
    const batch = await getBatchRecord(admin, params.batchId);

    if (batch) {
      return Response.json({
        progress: { status: "complete", completed: batch.count, total: batch.count, errors: [] },
        csvContent: null,
        _debug: { instanceId: INSTANCE_ID, source: "registry-fallback" },
      });
    }

    return Response.json({
      progress: { status: "processing", completed: 0, total: 0, errors: [] },
      csvContent: null,
      _debug: { instanceId: INSTANCE_ID, source: "registry-fallback-no-batch" },
    });
  } catch (err) {
    // Return the real error directly in the response body so it's
    // visible in the Network tab without needing server log access.
    return Response.json(
      {
        _debug: {
          instanceId: INSTANCE_ID,
          source: "fallback-error",
          error: err?.message || String(err),
          stack: err?.stack,
        },
        progress: { status: "processing", completed: 0, total: 0, errors: [] },
        csvContent: null,
      },
      { status: 200 }, // 200, not 500 — so it doesn't get swallowed by a generic error boundary
    );
  }
};