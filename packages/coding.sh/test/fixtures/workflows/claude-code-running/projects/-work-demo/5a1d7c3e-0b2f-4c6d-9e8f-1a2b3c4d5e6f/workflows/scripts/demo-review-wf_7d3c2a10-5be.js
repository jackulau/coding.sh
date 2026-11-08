export const meta = {
  name: 'demo-review',
  description: 'Review the docs and the tests of the demo repo',
  phases: [{ title: 'Review', detail: 'docs and tests' }],
}

phase('Review')
const reviews = await parallel([
  () => agent('List the docs in /work/demo/docs and say which are out of date.', { label: 'review:docs' }),
  () => agent('List the tests in /work/demo/test and say which are slow.', { label: 'review:tests' }),
])
log(`reviews done: ${reviews.filter(Boolean).length}/2`)
