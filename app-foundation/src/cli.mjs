import { readFileSync } from 'node:fs';
import { buildPreview } from './preview.mjs';

// Reads only the explicitly supplied JSON. No Google/Finmap/bank connection.
const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('-')) {
  console.error('Usage: node src/cli.mjs /absolute/path/to/approved-snapshot.json');
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse(readFileSync(args[0], 'utf8'));
    console.log(JSON.stringify(buildPreview(input), null, 2));
  } catch (error) {
    console.error(`Preview rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
