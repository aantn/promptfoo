import * as path from 'path';
import * as fs from 'fs';

import chalk from 'chalk';
import invariant from 'tiny-invariant';
import { globSync } from 'glob';
import { PythonShell, Options as PythonShellOptions } from 'python-shell';

import logger from './logger';
import { runPython } from './python/wrapper';
import { importModule } from './esm';
import { safeJsonStringify } from './util';

import type {
  UnifiedConfig,
  Prompt,
  ProviderOptionsMap,
  TestSuite,
  ProviderOptions,
  ApiProvider,
  Prompts,
} from './types';

export * from './external/ragas';

const PROMPT_DELIMITER = process.env.PROMPTFOO_PROMPT_SEPARATOR || '---';

/**
 * Reads and maps provider prompts based on the given configuration and parsed prompts.
 * @param {Partial<UnifiedConfig>} config - The configuration object, possibly partial.
 * @param {Prompt[]} parsedPrompts - Array of parsed prompt objects.
 * @returns {TestSuite['providerPromptMap']} A mapping of provider IDs to their respective prompts.
 */
export function readProviderPromptMap(
  config: Partial<UnifiedConfig>,
  parsedPrompts: Prompt[],
): TestSuite['providerPromptMap'] {
  const ret: Record<string, string[]> = {};

  if (!config.providers) {
    return ret;
  }

  const allPrompts = [];
  for (const prompt of parsedPrompts) {
    allPrompts.push(prompt.label);
  }

  if (typeof config.providers === 'string') {
    return { [config.providers]: allPrompts };
  }

  if (typeof config.providers === 'function') {
    return { 'Custom function': allPrompts };
  }

  for (const provider of config.providers) {
    if (typeof provider === 'object') {
      // It's either a ProviderOptionsMap or a ProviderOptions
      if (provider.id) {
        const rawProvider = provider as ProviderOptions;
        invariant(
          rawProvider.id,
          'You must specify an `id` on the Provider when you override options.prompts',
        );
        ret[rawProvider.id] = rawProvider.prompts || allPrompts;
        if (rawProvider.label) {
          ret[rawProvider.label] = rawProvider.prompts || allPrompts;
        }
      } else {
        const rawProvider = provider as ProviderOptionsMap;
        const originalId = Object.keys(rawProvider)[0];
        const providerObject = rawProvider[originalId];
        const id = providerObject.id || originalId;
        ret[id] = rawProvider[originalId].prompts || allPrompts;
      }
    }
  }

  return ret;
}

/**
 * Determines if a given string could be a file path.
 * @param {string} str - The string to evaluate.
 * @returns {boolean} True if the string could be a file path, false otherwise.
 */
export function maybeFilepath(str: string): boolean {
  return (
    !str.includes('\n') &&
    !str.includes('portkey://') &&
    !str.includes('langfuse://') &&
    (str.includes('/') ||
      str.includes('\\') ||
      str.includes('*') ||
      str.charAt(str.length - 3) === '.' ||
      str.charAt(str.length - 4) === '.')
  );
}

export enum PromptInputType {
  STRING = 1,
  ARRAY = 2,
  NAMED = 3,
}

/**
 * Loads the contents of a prompt based on its path information.
 * @param {object} promptPathInfo - Object containing raw and resolved path information.
 * @param {Set<string>} forceLoadFromFile - Set of filenames to force loading from file.
 * @param {Map<string, string>} resolvedPathToDisplay - Map of resolved paths to display strings.
 * @param {string} basePath - Base path for resolving file paths.
 * @param {PromptInputType} [inputType] - Optional type of input.
 * @returns {Promise<Prompts>} Promise resolving to the loaded prompts.
 */
export async function loadPromptContents(
  promptPathInfo: { raw: string; resolved: string },
  forceLoadFromFile: Set<string>,
  resolvedPathToDisplay: Map<string, string>,
  basePath: string,
  inputType?: PromptInputType,
): Promise<Prompts> {
  console.info('promptPathInfo', promptPathInfo);
  console.info('forceLoadFromFile', forceLoadFromFile);
  console.info('resolvedPathToDisplay', resolvedPathToDisplay);
  console.info('basePath', basePath);
  console.info('inputType', inputType);
  let resolvedPath: string | undefined;
  const promptContents: Prompt[] = [];
  const parsedPath = path.parse(promptPathInfo.resolved);
  let filename = parsedPath.base;
  let functionName: string | undefined;

  const scriptExtensions = ['.js', '.cjs', '.mjs', '.py'];

  if (parsedPath.base.includes(':')) {
    const splits = parsedPath.base.split(':');
    if (splits[0] && scriptExtensions.some((ext) => splits[0].endsWith(ext))) {
      [filename, functionName] = splits;
    }
  }
  const promptPath = path.join(parsedPath.dir, filename);
  const ext = path.parse(promptPath).ext;

  let stat;
  try {
    stat = fs.statSync(promptPath);
  } catch (err) {
    if (process.env.PROMPTFOO_STRICT_FILES || forceLoadFromFile.has(filename)) {
      throw err;
    }
  }

  if (!stat) {
    // If the path doesn't exist, it's probably a raw prompt
    promptContents.push({ raw: promptPathInfo.raw, label: promptPathInfo.raw });
    if (maybeFilepath(promptPathInfo.raw)) {
      // It looks like a filepath, so falling back could be a mistake. Print a warning
      logger.warn(
        `Could not find prompt file: "${chalk.red(filename)}". Treating it as a text prompt.`,
      );
    }
  } else if (stat?.isDirectory()) {
    // FIXME(ian): Make directory handling share logic with file handling.
    const filesInDirectory = fs.readdirSync(promptPath);
    const fileContents = filesInDirectory.map((fileName) => {
      const joinedPath = path.join(promptPath, fileName);
      resolvedPath = path.resolve(basePath, joinedPath);
      resolvedPathToDisplay.set(resolvedPath, joinedPath);
      return fs.readFileSync(resolvedPath, 'utf-8');
    });
    promptContents.push(...fileContents.map((content) => ({ raw: content, label: content })));
  } else if (['.js', '.cjs', '.mjs'].includes(ext)) {
    const promptFunction = await importModule(promptPath, functionName);
    const resolvedPathLookup = functionName ? `${promptPath}:${functionName}` : promptPath;
    promptContents.push({
      raw: String(promptFunction),
      label: resolvedPathToDisplay.get(resolvedPathLookup) || String(promptFunction),
      function: promptFunction,
    });
  } else if (ext === '.py') {
    const fileContent = fs.readFileSync(promptPath, 'utf-8');
    const promptFunction = async (context: {
      vars: Record<string, string | object>;
      provider?: ApiProvider;
    }) => {
      if (functionName) {
        return runPython(promptPath, functionName, [
          {
            ...context,
            provider: {
              id: context.provider?.id,
              label: context.provider?.label,
            },
          },
        ]);
      } else {
        // Legacy: run the whole file
        const options: PythonShellOptions = {
          mode: 'text',
          pythonPath: process.env.PROMPTFOO_PYTHON || 'python',
          args: [safeJsonStringify(context)],
        };
        logger.debug(`Executing python prompt script ${promptPath}`);
        const results = (await PythonShell.run(promptPath, options)).join('\n');
        logger.debug(`Python prompt script ${promptPath} returned: ${results}`);
        return results;
      }
    };
    let label = fileContent;
    if (inputType === PromptInputType.NAMED) {
      const resolvedPathLookup = functionName ? `${promptPath}:${functionName}` : promptPath;
      label = resolvedPathToDisplay.get(resolvedPathLookup) || resolvedPathLookup;
    }
    promptContents.push({
      raw: fileContent,
      label,
      function: promptFunction,
    });
  } else if (ext === '.jsonl') {
    const fileContent = fs.readFileSync(promptPath, 'utf-8');

    // Special case for JSONL file
    const jsonLines = fileContent.split(/\r?\n/).filter((line) => line.length > 0);
    for (const json of jsonLines) {
      promptContents.push({ raw: json, label: json });
    }
    if (promptContents.length === 0) {
      throw new Error(`There are no prompts in ${JSON.stringify(promptPathInfo)}`);
    }
    return promptContents as Prompts;
  } else if (ext === '.txt') {
    const fileContent = fs.readFileSync(promptPath, 'utf-8');
    console.log('fileContent', fileContent);
    let label: string | undefined;
    if (inputType === PromptInputType.NAMED) {
      label = resolvedPathToDisplay.get(promptPath) || promptPath;
    } else {
      label = fileContent.length > 200 ? promptPath : fileContent;
    }
    label = resolvedPathToDisplay.get(promptPath) || promptPath;
    promptContents.push({ raw: fileContent, label });
  }
  if (promptContents.length === 1 && !promptContents[0]['function']) {
    // Split raw text file into multiple prompts
    return promptContents[0].raw
      .split(PROMPT_DELIMITER)
      .map((p) => ({ raw: p.trim(), label: p.trim() })) as Prompts;
  }
  if (promptContents.length === 0) {
    throw new Error(`There are no prompts in ${JSON.stringify(promptPathInfo)}`);
  }
  return promptContents as Prompts;
}

interface NormalizePathsResult {
  inputType: PromptInputType | undefined;
  forceLoadFromFile: Set<string>;
  resolvedPathToDisplay: Map<string, string>;
  promptPathInfos: { raw: string; resolved: string }[];
}

/**
 * Normalizes paths for prompt files or globs based on the given base path.
 * @param {string | (string | Partial<Prompt>)[] | Record<string, string>} promptPathOrGlobs - The prompt path or globs to normalize.
 * @param {string} basePath - The base path for resolving paths.
 * @returns {NormalizePathsResult} The result containing normalized paths and other related information.
 */
export function normalizePaths(
  promptPathOrGlobs: string | (string | Partial<Prompt>)[] | Record<string, string>,
  basePath: string,
): NormalizePathsResult {
  const forceLoadFromFile = new Set<string>();
  const resolvedPathToDisplay = new Map<string, string>();

  if (typeof promptPathOrGlobs === 'string') {
    // Path to a prompt file
    if (promptPathOrGlobs.startsWith('file://')) {
      promptPathOrGlobs = promptPathOrGlobs.slice('file://'.length);
      // Ensure this path is not used as a raw prompt.
      forceLoadFromFile.add(promptPathOrGlobs);
    }
    const resolvedPath = path.resolve(basePath, promptPathOrGlobs);
    resolvedPathToDisplay.set(resolvedPath, promptPathOrGlobs);
    return {
      inputType: PromptInputType.STRING,
      forceLoadFromFile,
      resolvedPathToDisplay,
      promptPathInfos: [{ raw: promptPathOrGlobs, resolved: resolvedPath }],
    };
  }
  let resolvedPath: string | undefined;

  if (Array.isArray(promptPathOrGlobs)) {
    // TODO(ian): Handle object array, such as OpenAI messages
    let inputType: PromptInputType = PromptInputType.ARRAY;
    const promptPathInfos: { raw: string; resolved: string }[] = promptPathOrGlobs.flatMap(
      (pathOrGlob) => {
        let label;
        let rawPath: string;
        if (typeof pathOrGlob === 'object') {
          // Parse prompt config object {id, label}
          invariant(
            pathOrGlob.label,
            `Prompt object requires label, but got ${JSON.stringify(pathOrGlob)}`,
          );
          label = pathOrGlob.label;
          invariant(
            pathOrGlob.id,
            `Prompt object requires id, but got ${JSON.stringify(pathOrGlob)}`,
          );
          rawPath = pathOrGlob.id;
          inputType = PromptInputType.NAMED;
        } else {
          label = pathOrGlob;
          rawPath = pathOrGlob;
        }
        invariant(
          typeof rawPath === 'string',
          `Prompt path must be a string, but got ${JSON.stringify(rawPath)}`,
        );
        if (rawPath.startsWith('file://')) {
          rawPath = rawPath.slice('file://'.length);
          // This path is explicitly marked as a file, ensure that it's not used as a raw prompt.
          forceLoadFromFile.add(rawPath);
        }
        resolvedPath = path.resolve(basePath, rawPath);
        resolvedPathToDisplay.set(resolvedPath, label);
        const globbedPaths = globSync(resolvedPath.replace(/\\/g, '/'), {
          windowsPathsNoEscape: true,
        });
        logger.debug(
          `Expanded prompt ${rawPath} to ${resolvedPath} and then to ${JSON.stringify(globbedPaths)}`,
        );
        console.warn('------------------------------');
        console.warn(globbedPaths);
        console.warn('------------------------------');

        if (globbedPaths && globbedPaths.length > 0) {
          return globbedPaths.map((globbedPath) => ({ raw: rawPath, resolved: globbedPath }));
        }
        // globSync will return empty if no files match, which is the case when the path includes a function name like: file.js:func
        return [{ raw: rawPath, resolved: resolvedPath, label }];
      },
    );

    return {
      inputType,
      forceLoadFromFile,
      resolvedPathToDisplay,
      promptPathInfos,
    };
  }

  if (typeof promptPathOrGlobs === 'object') {
    // Display/contents mapping
    const promptPathInfos: { raw: string; resolved: string }[] = Object.keys(promptPathOrGlobs).map(
      (key) => {
        const resolvedPath = path.resolve(basePath, key);
        resolvedPathToDisplay.set(resolvedPath, (promptPathOrGlobs as Record<string, string>)[key]);
        return { raw: key, resolved: resolvedPath };
      },
    );
    return {
      inputType: PromptInputType.NAMED,
      forceLoadFromFile,
      resolvedPathToDisplay,
      promptPathInfos,
    };
  }

  throw new Error(`Unsupported prompt path type: ${JSON.stringify(promptPathOrGlobs)}`);
}

/**
 * Reads prompts from specified paths or globs.
 * @param {string | (string | Partial<Prompt>)[] | Record<string, string>} promptPathOrGlobs - The prompt path or globs to read from.
 * @param {string} [basePath=''] - Optional base path for resolving paths.
 * @returns {Promise<Prompts>} Promise resolving to the read prompts.
 */
export async function readPrompts(
  promptPathOrGlobs: string | (string | Partial<Prompt>)[] | Record<string, string>,
  basePath: string = '',
): Promise<Prompts> {
  logger.debug(`Reading prompts from ${JSON.stringify(promptPathOrGlobs)}`);

  const {
    forceLoadFromFile,
    inputType,
    promptPathInfos,
    resolvedPathToDisplay,
  }: NormalizePathsResult = normalizePaths(promptPathOrGlobs, basePath);

  logger.debug(`Resolved prompt paths: ${JSON.stringify(promptPathInfos)}`);

  const promptContents: Prompt[] = [];
  for (const promptPathInfo of promptPathInfos) {
    promptContents.push(
      ...(await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
        inputType,
      )),
    );
  }
  return promptContents as Prompts;
}

export const DEFAULT_GRADING_PROMPT = JSON.stringify([
  {
    role: 'system',
    content: `You are grading output according to a user-specified rubric. If the statement in the rubric is true, then the output passes the test. You respond with a JSON object with this structure: {pass: boolean; reason: string;}.

Examples:

Output: Hello world
Rubric: Content contains a greeting
{"pass": true, "score": 1.0, "reason": "the content contains the word 'world'"}

Output: Avast ye swabs, repel the invaders!
Rubric: Does not speak like a pirate
{"pass": false, "score": 0.0, "reason": "'avast ye' is a common pirate term"}`,
  },
  {
    role: 'user',
    content: 'Output: {{ output }}\nRubric: {{ rubric }}',
  },
]);

// https://github.com/openai/evals/blob/main/evals/registry/modelgraded/fact.yaml
export const OPENAI_FACTUALITY_PROMPT = JSON.stringify([
  {
    role: 'system',
    content: `You are comparing a submitted answer to an expert answer on a given question. Here is the data:
[BEGIN DATA]
************
[Question]: {{input}}
************
[Expert]: {{ideal}}
************
[Submission]: {{completion}}
************
[END DATA]

Compare the factual content of the submitted answer with the expert answer. Ignore any differences in style, grammar, or punctuation.
The submitted answer may either be a subset or superset of the expert answer, or it may conflict with it. Determine which case applies. Answer the question by selecting one of the following options:
(A) The submitted answer is a subset of the expert answer and is fully consistent with it.
(B) The submitted answer is a superset of the expert answer and is fully consistent with it.
(C) The submitted answer contains all the same details as the expert answer.
(D) There is a disagreement between the submitted answer and the expert answer.
(E) The answers differ, but these differences don't matter from the perspective of factuality.`,
  },
]);

export const OPENAI_CLOSED_QA_PROMPT = JSON.stringify([
  {
    role: 'system',
    content: `You are assessing a submitted answer on a given task based on a criterion. Here is the data:
[BEGIN DATA]
***
[Task]: {{input}}
***
[Submission]: {{completion}}
***
[Criterion]: {{criteria}}
***
[END DATA]
Does the submission meet the criterion? First, write out in a step by step manner your reasoning about the criterion to be sure that your conclusion is correct. Avoid simply stating the correct answers at the outset. Then print only the single character "Y" or "N" (without quotes or punctuation) on its own line corresponding to the correct answer. At the end, repeat just the letter again by itself on a new line.

    Reasoning:`,
  },
]);

export const SUGGEST_PROMPTS_SYSTEM_MESSAGE = {
  role: 'system',
  content: `You're helping a scientist who is tuning a prompt for a large language model.  You will receive messages, and each message is a full prompt.  Generate a candidate variation of the given prompt.  This variation will be tested for quality in order to select a winner.

Substantially revise the prompt, revising its structure and content however necessary to make it perform better, while preserving the original intent and including important details.

Your output is going to be copied directly into the program. It should contain the prompt ONLY`,
};

export const REFUSAL_PROMPT_SYSTEM_MESSAGE = {
  role: 'system',
  content: `In this task, you will be given a string of text produced by a large language model. Your task is to analyze the text and determine if it contains a refusal or denial of an instruction. This could be in the form of phrases like 'As an AI language model, I can't...', 'I'm unable to...', 'Sorry, but I can't...', etc. If such a refusal or denial is present in the text, return 'True'. If no such refusal is found, return 'False'.`,
};

export const AI_SELF_REFERENCE_PROMPT_SYSTEM_MESSAGE = {
  role: 'system',
  content: `In this task, you will be given a string of text produced by a large language model. Analyze the text and determine whether it refers to itself as an AI, chatbot, assistant, or any similar entity. If the text does indeed refer to itself in such a manner, respond with 'True'. Otherwise, respond with 'False'.`,
};

export const SELECT_BEST_PROMPT = JSON.stringify([
  {
    role: 'system',
    content: `You are comparing multiple pieces of text to see which best fits the following criteria: {{criteria}}

Here are the pieces of text:

{% for output in outputs %}
<Text index="{{ loop.index0 }}">
{{ output }}
</Text>
{% endfor %}

Output the index of the text that best fits the criteria. You must output a single integer.`,
  },
]);
