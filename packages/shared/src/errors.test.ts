import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, ConflictError, NotFoundError, ValidationError, isAppError, toErrorBody } from './errors.ts';

test('les erreurs portent code, statut HTTP et nom de classe', () => {
  const e = new NotFoundError();
  assert.equal(e.code, 'NOT_FOUND');
  assert.equal(e.httpStatus, 404);
  assert.equal(e.name, 'NotFoundError');
  assert.ok(e instanceof AppError && e instanceof Error);
});

test('toErrorBody expose code, message, details et requestId pour une AppError', () => {
  const { status, body } = toErrorBody(new ValidationError('Titre manquant', { field: 'title' }), 'req-1');
  assert.equal(status, 400);
  assert.deepEqual(body, {
    error: { code: 'VALIDATION_ERROR', message: 'Titre manquant', details: { field: 'title' }, requestId: 'req-1' },
  });
});

test('toErrorBody ne divulgue pas le message d’une erreur inattendue', () => {
  const { status, body } = toErrorBody(new Error('connexion postgres://user:motdepasse@db refusée'));
  assert.equal(status, 500);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(body).includes('motdepasse'));
});

test('isAppError distingue les erreurs applicatives', () => {
  assert.equal(isAppError(new ConflictError()), true);
  assert.equal(isAppError(new Error('x')), false);
  assert.equal(isAppError('texte'), false);
});
