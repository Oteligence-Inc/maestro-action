import * as fs from 'fs';
import * as path from 'path';

const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

it('runs the bundle again as an unconditional post step, so a stopped run is still closed', () => {
  expect(actionYml).toMatch(/^ {2}post: 'dist\/index\.js'$/m);
  expect(actionYml).not.toMatch(/^ {2}post-if:/m);
});
