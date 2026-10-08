import { RemovedServiceError } from '../src/util/errors';

it('names the services the environment does register, so a wrong service input can be corrected', () => {
  const err = new RemovedServiceError('fundtransfer', 'dev', ['fund-transfer-service', 'account-service']);
  expect(err.message).toContain('"fundtransfer"');
  expect(err.message).toContain('Registered in "dev": account-service, fund-transfer-service.');
});
