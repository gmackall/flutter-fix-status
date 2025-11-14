// Simple unit tests for core utility functions
import { classify, releasesAgo } from '../src/utils.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function testClassify() {
  console.log('Testing classify function...');
  
  // Test commit SHA
  const commitResult = classify('3f2a7bc');
  assert(commitResult.type === 'commit', 'Should recognize commit SHA');
  assert(commitResult.value === '3f2a7bc', 'Should return commit value');
  
  // Test PR URL
  const prResult = classify('https://github.com/flutter/flutter/pull/12345');
  assert(prResult.type === 'pr', 'Should recognize PR URL');
  assert(prResult.value === '12345', 'Should extract PR number');
  
  // Test issue URL
  const issueResult = classify('https://github.com/flutter/flutter/issues/67890');
  assert(issueResult.type === 'issue', 'Should recognize issue URL');
  assert(issueResult.value === '67890', 'Should extract issue number');
  
  // Test number-only (ambiguous)
  const numResult = classify('123');
  assert(numResult.type === 'maybe-pr-or-issue', 'Should recognize ambiguous number');
  assert(numResult.value === '123', 'Should return number value');
  
  console.log('✓ classify tests passed');
}

function testReleasesAgo() {
  console.log('Testing releasesAgo function...');
  
  assert(releasesAgo(10, 5) === '5', 'Should calculate releases ago correctly');
  assert(releasesAgo(5, 5) === '0', 'Should return 0 for same index');
  assert(releasesAgo(10, null) === '—', 'Should return dash for null');
  
  console.log('✓ releasesAgo tests passed');
}

// Run all tests
try {
  testClassify();
  testReleasesAgo();
  console.log('\n✓ All tests passed!');
  process.exit(0);
} catch (error) {
  console.error('\n✗ Test failed:', error.message);
  process.exit(1);
}
