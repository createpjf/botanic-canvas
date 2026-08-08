const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : 0

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** 固定离线夹具的质量评测器；不接触 Planner、Queue 或真实 Provider。 */
export function evaluateAgentRunFixtures(fixtures) {
  const samples = Array.isArray(fixtures) ? fixtures : []
  const successful = samples.filter((sample) => sample.status === 'completed' || sample.status === 'partial')
  const recovered = samples.filter((sample) => sample.recovered)
  const logicalSubmissions = samples.reduce((total, sample) => total + Math.max(0, Number(sample.logicalSubmissions) || 0), 0)
  const duplicateJobs = samples.reduce((total, sample) => total + Math.max(0, (Number(sample.createdJobs) || 0) - 1), 0)
  const completeWritebacks = samples.filter((sample) => (
    sample.writebackComplete
    && Math.max(0, Number(sample.artifactCount) || 0) >= Math.max(0, Number(sample.expectedOutputs) || 0)
  ))
  return {
    sampleCount: samples.length,
    successRate: ratio(successful.length, samples.length),
    medianWaitMs: median(samples.map((sample) => Math.max(0, Number(sample.firstProgressAt) - Number(sample.createdAt))).filter(Number.isFinite)),
    recoveryRate: ratio(recovered.filter((sample) => sample.status === 'completed' || sample.status === 'partial').length, recovered.length),
    duplicateSubmissionRate: ratio(duplicateJobs, logicalSubmissions),
    resultWritebackCompleteness: ratio(completeWritebacks.length, samples.length),
  }
}
