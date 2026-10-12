import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// All prompts and Cloudflare processes are replaced inside Python. Only assertion
// outcomes return to Node; credentials never enter argv or inherited environment.
const harness = String.raw`
import contextlib, importlib.util, io, os, subprocess, sys
from unittest.mock import patch
from pathlib import Path
path = Path('scripts/billing/provision-development-sandbox.py').resolve()
spec = importlib.util.spec_from_file_location('provision_synthetic', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
names = ['WOMPI_PUBLIC_KEY','WOMPI_PRIVATE_KEY','WOMPI_INTEGRITY_SECRET','WOMPI_EVENTS_SECRET']
prefixes = ['pub_test_','prv_test_','test_integrity_','test_events_']
values = [prefix + 'syntheticQA' for prefix in prefixes]
scenario, position = sys.argv[1], int(sys.argv[2])
original_environment = dict(os.environ)

def run(inputs, tty=True, failure=False):
    output, calls, prompts = io.StringIO(), [], []
    iterator = iter(inputs)
    def prompt(label):
        prompts.append(label)
        return next(iterator)
    def process(argv, **kwargs):
        assert len(prompts) == 4, 'All inputs must validate before any write'
        index = len(calls)
        assert argv == ['pnpm','exec','wrangler','secret','put',names[index],
                        '--config','apps/api/wrangler.jsonc','--env','development']
        assert kwargs['input'] == values[index] + '\n'
        assert kwargs['text'] is True and kwargs['capture_output'] is True
        assert kwargs['cwd'] == path.parents[2]
        assert 'env' not in kwargs
        assert not any(value in str(argv) for value in values)
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 1 if failure else 0,
            stdout=values[index], stderr=values[index])
    error = None
    with patch.object(module.sys.stdin,'isatty',return_value=tty), \
         patch.object(module.getpass,'getpass',side_effect=prompt), \
         patch.object(module.subprocess,'run',side_effect=process), \
         contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            module.main()
        except SystemExit as exc:
            error = str(exc)
    assert dict(os.environ) == original_environment
    visible = output.getvalue() + (error or '')
    for value in values + inputs:
        if value:
            assert value not in visible, 'Sensitive prompt input leaked'
    return calls, prompts, error, visible

if scenario == 'production':
    production = ['pub_prod_','prv_prod_','prod_integrity_','prod_events_']
    inputs = values.copy()
    inputs[position] = production[position] + 'syntheticQA'
    calls, prompts, error, _ = run(inputs)
    assert not calls and len(prompts) == position + 1 and 'Sandbox format required' in error
elif scenario == 'malformed':
    for invalid in ['', prefixes[position], prefixes[position]+'syntheticQA ',
                    prefixes[position]+'syntheticQA\n', prefixes[position]+('x'*257),
                    'syntheticQA', prefixes[position]+'syntheticQA!']:
        inputs = values.copy()
        inputs[position] = invalid
        calls, prompts, error, _ = run(inputs)
        assert not calls and len(prompts) == position + 1 and 'Sandbox format required' in error
elif scenario == 'valid':
    calls, prompts, error, visible = run(values)
    assert len(calls) == len(prompts) == 4 and error is None
    for name in names:
        assert 'Provisioned '+name+' on Development API.' in visible
elif scenario == 'nonTTY':
    calls, prompts, error, _ = run(values,tty=False)
    assert not calls and not prompts and 'interactive local terminal' in error
elif scenario == 'failure':
    calls, prompts, error, visible = run(values,failure=True)
    assert len(calls) == 1 and len(prompts) == 4
    assert 'Could not provision WOMPI_PUBLIC_KEY' in error
    assert 'Provisioned' not in visible
else:
    raise AssertionError('Unknown test scenario')
print('safe assertions passed')
`;
function check(scenario: string, position = 0) {
  expect(
    execFileSync("python3", ["-c", harness, scenario, String(position)], {
      encoding: "utf8",
    }).trim(),
  ).toBe("safe assertions passed");
}

describe("hidden-input Development Wompi provisioning", () => {
  it.each([0, 1, 2, 3])(
    "rejects production credentials at position %i before any binding write",
    (position) => check("production", position),
  );
  it.each([0, 1, 2, 3])(
    "rejects malformed credentials at position %i before any binding write",
    (position) => check("malformed", position),
  );
  it("writes all four Sandbox values only through subprocess stdin", () =>
    check("valid"));
  it("refuses noninteractive input before prompting", () => check("nonTTY"));
  it("redacts captured process failure output and stops further writes", () =>
    check("failure"));
});
