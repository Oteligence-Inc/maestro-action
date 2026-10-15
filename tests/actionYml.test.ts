import * as fs from 'fs';
import * as path from 'path';

const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

it('runs the post bundle as an unconditional post step, so a stopped run is still closed', () => {
  expect(actionYml).toMatch(/^ {2}main: 'dist\/index\.js'$/m);
  expect(actionYml).toMatch(/^ {2}post: 'dist\/post\/index\.js'$/m);
  expect(actionYml).not.toMatch(/^ {2}post-if:/m);
});
