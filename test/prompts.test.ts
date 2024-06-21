import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

import {
  PromptInputType,
  loadPromptContents,
  maybeFilepath,
  normalizePaths,
  readPrompts,
  readProviderPromptMap,
} from '../src/prompts';
import { runPython } from '../src/python/wrapper';
import type { Prompt, UnifiedConfig } from '../src/types';

jest.mock('../src/esm');
jest.mock('../src/python/wrapper', () => ({
  runPython: jest.fn(),
}));
jest.mock('../src/database');

jest.mock('proxy-agent', () => ({
  ProxyAgent: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('glob', () => ({
  globSync: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
  writeFileSync: jest.fn(),
}));
jest.mock('path', () => {
  const actual = jest.requireActual('path');
  return {
    ...actual,
    join: jest.fn(actual.join),
    parse: jest.fn(actual.parse),
    resolve: jest.fn(actual.resolve),
  };
});

function toPrompt(text: string): Prompt {
  return { raw: text, label: text };
}

describe('prompts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('readPrompts', () => {
    it('with single prompt file', async () => {
      jest.mocked(fs.readFileSync).mockReturnValue('Test prompt 1\n---\nTest prompt 2');
      jest.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);
      const promptPaths = ['prompts.txt'];
      jest.mocked(globSync).mockImplementation((pathOrGlob) => [pathOrGlob] as string[]);

      const result = await readPrompts(promptPaths);

      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          label: 'prompts.txt: Test prompt 1',
          raw: 'Test prompt 1',
        },
        {
          label: 'prompts.txt: Test prompt 2',
          raw: 'Test prompt 2',
        },
      ]);
    });

    it('with multiple prompt files', async () => {
      jest
        .mocked(fs.readFileSync)
        .mockReturnValueOnce('Test prompt 1')
        .mockReturnValueOnce('Test prompt 2');
      jest.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);
      const promptPaths = ['prompt1.txt', 'prompt2.txt'];
      jest.mocked(globSync).mockImplementation((pathOrGlob) => [pathOrGlob] as string[]);

      const result = await readPrompts(promptPaths);

      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
      expect(result).toEqual([
        {
          label: 'prompt1.txt: Test prompt 1',
          raw: 'Test prompt 1',
        },
        {
          label: 'prompt2.txt: Test prompt 2',
          raw: 'Test prompt 2',
        },
      ]);
    });

    it('with directory', async () => {
      jest.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);
      jest.mocked(globSync).mockImplementation((pathOrGlob) => [pathOrGlob] as string[]);
      jest.mocked(fs.readdirSync).mockReturnValue(['prompt1.txt', 'prompt2.txt']);
      jest.mocked(fs.readFileSync).mockImplementation((filePath) => {
        if (filePath.toString().endsWith(path.join('prompts', 'prompt1.txt'))) {
          return 'Test prompt 1';
        } else if (filePath.toString().endsWith(path.join('prompts', 'prompt2.txt'))) {
          return 'Test prompt 2';
        }
      });
      const promptPaths = ['prompts'];

      const result = await readPrompts(promptPaths);

      expect(fs.statSync).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
      expect(result).toEqual([
        {
          label: 'Test prompt 1',
          raw: 'Test prompt 1',
        },
        {
          label: 'Test prompt 2',
          raw: 'Test prompt 2',
        },
      ]);
    });

    it('with empty input', async () => {
      jest.mocked(fs.readFileSync).mockReturnValue('');
      jest.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false });
      const promptPaths = ['prompts.txt'];

      const result = await readPrompts(promptPaths);

      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          label: '',
          raw: '',
        },
      ]);
    });

    it('with map input', async () => {
      jest.mocked(fs.readFileSync).mockReturnValue('some raw text');
      jest.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false });

      const result = await readPrompts({
        'prompts.txt': 'foo1',
        'prompts.py': 'foo2',
      });

      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);

      expect(result).toEqual([
        { raw: 'some raw text', label: 'some raw text' },
        expect.objectContaining({ raw: 'some raw text', label: 'foo2' }),
      ]);
    });

    it('with JSONL file', async () => {
      const data = [
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Who won the world series in {{ year }}?' },
        ],
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Who won the superbowl in {{ year }}?' },
        ],
      ];

      jest.mocked(fs.readFileSync).mockReturnValue(data.map((o) => JSON.stringify(o)).join('\n'));
      jest.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false });
      const promptPaths = ['prompts.jsonl'];

      const result = await readPrompts(promptPaths);

      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          label: JSON.stringify(data[0]),
          raw: JSON.stringify(data[0]),
        },
        {
          label: JSON.stringify(data[1]),
          raw: JSON.stringify(data[1]),
        },
      ]);
    });

    it('with .py file', async () => {
      const code = `print('dummy prompt')`;
      jest.mocked(fs.readFileSync).mockReturnValue(code);
      const result = await readPrompts('prompt.py');
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(result[0].raw).toEqual(code);
      expect(result[0].label).toEqual(code);
      expect(result[0].function).toBeDefined();
    });

    it('with Prompt object array', async () => {
      const prompts = [
        { id: 'prompts.py:prompt1', label: 'First prompt' },
        { id: 'prompts.py:prompt2', label: 'Second prompt' },
      ];

      const code = `
def prompt1:
  return 'First prompt'
def prompt2:
  return 'Second prompt'
`;
      jest.mocked(fs.readFileSync).mockReturnValue(code);

      const result = await readPrompts(prompts);

      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result).toEqual([
        {
          raw: code,
          label: 'First prompt',
          function: expect.any(Function),
        },
        {
          raw: code,
          label: 'Second prompt',
          function: expect.any(Function),
        },
      ]);
    });

    it('readPrompts with .js file', async () => {
      jest.doMock(
        path.resolve('prompt.js'),
        () => {
          return jest.fn(() => console.log('dummy prompt'));
        },
        { virtual: true },
      );
      const result = await readPrompts('prompt.js');
      expect(result[0].function).toBeDefined();
    });

    it('readPrompts with glob pattern for .txt files', async () => {
      const fileContents: Record<string, string> = {
        '1.txt': 'First text file content',
        '2.txt': 'Second text file content',
      };

      jest.mocked(fs.readFileSync).mockImplementation((path: fs.PathLike) => {
        if (path.toString().includes('1.txt')) {
          return fileContents['1.txt'];
        } else if (path.toString().includes('2.txt')) {
          return fileContents['2.txt'];
        }
        throw new Error('Unexpected file path in test');
      });
      jest.mocked(fs.statSync).mockImplementation(
        (path: fs.PathLike) =>
          ({
            isDirectory: () => path.toString().includes('prompts'),
          }) as fs.Stats,
      );
      jest.mocked(fs.readdirSync).mockImplementation((path: fs.PathLike) => {
        if (path.toString().includes('prompts')) {
          return ['prompt1.txt', 'prompt2.txt'];
        }
        throw new Error('Unexpected directory path in test');
      });

      const promptPaths = ['file://./prompts/*.txt'];

      const result = await readPrompts(promptPaths);

      expect(fs.readdirSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
      expect(fs.statSync).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          raw: fileContents['1.txt'],
          label: fileContents['1.txt'],
        },
        {
          raw: fileContents['2.txt'],
          label: fileContents['2.txt'],
        },
      ]);
    });
  });

  describe('loadPromptContents', () => {
    const basePath = '/base/path';
    const promptPathInfo = { raw: 'rawPrompt', resolved: '/resolved/path/prompt.txt' };
    const forceLoadFromFile = new Set<string>();
    const resolvedPathToDisplay = new Map<string, string>();

    const mockedFs = fs as jest.Mocked<typeof fs>;
    const mockedPath = path as jest.Mocked<typeof path>;

    it('should load raw prompt if the path does not exist', async () => {
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('File not found');
      });
      const result = await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
      );
      expect(result).toEqual([{ raw: 'rawPrompt', label: 'rawPrompt' }]);
    });

    it('should handle raw prompt and log warning if stat is undefined and it looks like a filepath', async () => {
      const promptPathInfo = { raw: 'raw/path/to/file.txt', resolved: '/resolved/path/prompt.txt' };
      const forceLoadFromFile = new Set<string>();
      const resolvedPathToDisplay = new Map<string, string>();
      const basePath = '/base/path';

      jest.mocked(fs.statSync).mockReturnValue(undefined);

      const result = await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
      );

      expect(result).toEqual([{ raw: 'raw/path/to/file.txt', label: 'raw/path/to/file.txt' }]);
    });

    it('should handle directory prompts', async () => {
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
      mockedFs.readdirSync.mockReturnValue(['file1.txt', 'file2.txt']);
      mockedFs.readFileSync.mockImplementation((filePath) => {
        if (filePath.toString().includes('file1.txt')) return 'Content of file1';
        if (filePath.toString().includes('file2.txt')) return 'Content of file2';
        return '';
      });
      mockedPath.join.mockImplementation((...args) => args.join('/'));

      const result = await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
      );
      expect(result).toEqual([
        { raw: 'Content of file1', label: 'Content of file1' },
        { raw: 'Content of file2', label: 'Content of file2' },
      ]);
    });

    it('should handle JavaScript prompt files', async () => {
      mockedFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
      mockedPath.parse.mockReturnValue({
        base: 'prompt.js',
        dir: '/resolved/path',
        ext: '.js',
        name: 'prompt',
        root: '/',
      });
      jest.mock('/resolved/path/prompt.js', () => jest.fn(() => 'JS Prompt Content'), {
        virtual: true,
      });

      const result = await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
      );
      expect(result).toEqual([
        {
          function: expect.any(Function),
          raw: `function () {
  return fn.apply(this, arguments);
}`,
        },
      ]);
    });

    it('should handle Python prompt files', async () => {
      mockedFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
      mockedFs.readFileSync.mockReturnValue('Python file content');
      mockedPath.parse.mockReturnValue({
        base: 'prompt.py',
        dir: '/resolved/path',
        ext: '.py',
        name: 'prompt',
        root: '/',
      });

      const result = await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
      );
      expect(result[0].raw).toBe('Python file content');
      expect(result[0].function).toBeInstanceOf(Function);
    });

    describe.skip('python', () => {
      const basePath = '/base/path';
      const promptPathInfo = { raw: 'rawPrompt', resolved: '/resolved/path/prompt.py' };
      const forceLoadFromFile = new Set<string>();
      const resolvedPathToDisplay = new Map<string, string>();

      const mockedFs = fs as jest.Mocked<typeof fs>;
      const mockedPath = path as jest.Mocked<typeof path>;
      const mockedRunPython = jest.mocked(runPython);

      it('should handle Python prompt files', async () => {
        const fileContent = `print('dummy prompt')`;
        mockedFs.readFileSync.mockReturnValue(fileContent);
        mockedFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
        mockedPath.parse.mockReturnValue({
          base: 'prompt.py',
          dir: '/resolved/path',
          ext: '.py',
          name: 'prompt',
          root: '/',
        });

        const result = await loadPromptContents(
          promptPathInfo,
          forceLoadFromFile,
          resolvedPathToDisplay,
          basePath,
          PromptInputType.NAMED,
        );

        expect(result).toHaveLength(1);
        expect(result[0].raw).toBe(fileContent);
        expect(result[0].label).toBe('/resolved/path/prompt.py');
        expect(result[0].function).toBeInstanceOf(Function);

        // Test the function to ensure it calls runPython correctly
        const context = {
          vars: { test: 'data' },
          provider: { id: 'provider1', label: 'Provider 1' },
        };
        await result[0].function(context);

        expect(mockedRunPython).toHaveBeenCalledWith('/resolved/path/prompt.py', undefined, [
          {
            ...context,
            provider: {
              id: context.provider?.id,
              label: context.provider?.label,
            },
          },
        ]);
      });
    });

    it('should handle JSONL prompt files', async () => {
      mockedFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
      mockedFs.readFileSync.mockReturnValue('{"key1": "value1"}\n{"key2": "value2"}');
      mockedPath.parse.mockReturnValue({
        base: 'prompt.jsonl',
        dir: '/resolved/path',
        ext: '.jsonl',
        name: 'prompt',
        root: '/',
      });

      const result = await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
      );
      expect(result).toEqual([
        { raw: '{"key1": "value1"}', label: '{"key1": "value1"}' },
        { raw: '{"key2": "value2"}', label: '{"key2": "value2"}' },
      ]);
    });

    it('should handle text prompt files', async () => {
      mockedFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
      mockedFs.readFileSync.mockReturnValue('Text file content');
      mockedPath.parse.mockReturnValue({
        base: 'prompt.txt',
        dir: '/resolved/path',
        ext: '.txt',
        name: 'prompt',
        root: '/',
      });

      const result = await loadPromptContents(
        promptPathInfo,
        forceLoadFromFile,
        resolvedPathToDisplay,
        basePath,
      );
      expect(result).toEqual([{ raw: 'Text file content', label: 'Text file content' }]);
    });

    it('should throw an error if no prompts are found in JSONL files', async () => {
      mockedFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
      mockedFs.readFileSync.mockReturnValue('');
      mockedPath.parse.mockReturnValue({
        base: 'prompt.jsonl',
        dir: '/resolved/path',
        ext: '.jsonl',
        name: 'prompt',
        root: '/',
      });

      await expect(
        loadPromptContents(promptPathInfo, forceLoadFromFile, resolvedPathToDisplay, basePath),
      ).rejects.toThrow(`There are no prompts in ${JSON.stringify(promptPathInfo)}`);
    });

    it('should throw an error if PROMPTFOO_STRICT_FILES is set and statSync throws an error', async () => {
      process.env.PROMPTFOO_STRICT_FILES = 'true';
      mockedFs.statSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      await expect(
        loadPromptContents(promptPathInfo, forceLoadFromFile, resolvedPathToDisplay, basePath),
      ).rejects.toThrow('File not found');

      delete process.env.PROMPTFOO_STRICT_FILES;
    });

    it('should throw an error if no prompts are found', async () => {
      jest.spyOn(fs, 'readFileSync').mockReturnValue('');
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      jest.spyOn(path, 'parse').mockReturnValue({
        base: 'prompt.jsonl',
        dir: '/resolved/path',
        ext: '.jsonl',
        name: 'prompt',
        root: '/',
      });

      await expect(
        loadPromptContents(promptPathInfo, forceLoadFromFile, resolvedPathToDisplay, basePath),
      ).rejects.toThrow(`There are no prompts in ${JSON.stringify(promptPathInfo)}`);
    });
  });

  describe('normalizePaths', () => {
    const basePath = '/base/path';
    const mockedPath = path as jest.Mocked<typeof path>;
    const mockedGlobSync = jest.mocked(globSync);

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should normalize a single string path', () => {
      const promptPathOrGlobs = 'prompts.txt';
      mockedPath.resolve.mockImplementation((...args) => args.join('/'));

      const result = normalizePaths(promptPathOrGlobs, basePath);

      expect(result).toEqual({
        inputType: PromptInputType.STRING,
        forceLoadFromFile: new Set(),
        resolvedPathToDisplay: new Map([['/base/path/prompts.txt', 'prompts.txt']]),
        promptPathInfos: [{ raw: 'prompts.txt', resolved: '/base/path/prompts.txt' }],
      });
    });

    it('should normalize a string path starting with file://', () => {
      const promptPathOrGlobs = 'file://prompts.txt';
      mockedPath.resolve.mockImplementation((...args) => args.join('/'));

      const result = normalizePaths(promptPathOrGlobs, basePath);

      expect(result).toEqual({
        inputType: PromptInputType.STRING,
        forceLoadFromFile: new Set(['prompts.txt']),
        resolvedPathToDisplay: new Map([['/base/path/prompts.txt', 'prompts.txt']]),
        promptPathInfos: [{ raw: 'prompts.txt', resolved: '/base/path/prompts.txt' }],
      });
    });

    it('should handle array of string paths', () => {
      const promptPathOrGlobs = ['prompt1.txt', 'prompt2.txt'];
      const result = normalizePaths(promptPathOrGlobs, basePath);

      expect(result).toEqual({
        inputType: PromptInputType.ARRAY,
        forceLoadFromFile: new Set(),
        resolvedPathToDisplay: new Map([
          ['/base/path/prompt1.txt', 'prompt1.txt'],
          ['/base/path/prompt2.txt', 'prompt2.txt'],
        ]),
        promptPathInfos: [
          {
            raw: 'prompt1.txt',
            resolved: '/base/path/prompt1.txt',
          },
          {
            raw: 'prompt2.txt',
            resolved: '/base/path/prompt2.txt',
          },
        ],
      });
    });

    it('should handle object mapping of paths to display strings', () => {
      const promptPathOrGlobs = {
        'prompts/prompt1.txt': 'Prompt 1',
        'prompts/prompt2.txt': 'Prompt 2',
      };
      mockedPath.resolve.mockImplementation((...args) => args.join('/'));

      const result = normalizePaths(promptPathOrGlobs, basePath);

      expect(result).toEqual({
        inputType: PromptInputType.NAMED,
        forceLoadFromFile: new Set(),
        resolvedPathToDisplay: new Map([
          ['/base/path/prompts/prompt1.txt', 'Prompt 1'],
          ['/base/path/prompts/prompt2.txt', 'Prompt 2'],
        ]),
        promptPathInfos: [
          { raw: 'prompts/prompt1.txt', resolved: '/base/path/prompts/prompt1.txt' },
          { raw: 'prompts/prompt2.txt', resolved: '/base/path/prompts/prompt2.txt' },
        ],
      });
    });

    it('should handle globs in array of string paths', () => {
      const promptPathOrGlobs = ['file://./prompts/*.txt'];
      mockedGlobSync.mockReturnValue([
        '/base/path/prompts/prompt1.txt',
        '/base/path/prompts/prompt2.txt',
      ]);

      const result = normalizePaths(promptPathOrGlobs, basePath);

      expect(mockedGlobSync).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        inputType: PromptInputType.ARRAY,
        forceLoadFromFile: new Set(['./prompts/*.txt']),
        resolvedPathToDisplay: new Map([['/base/path/./prompts/*.txt', 'file://./prompts/*.txt']]),
        promptPathInfos: [
          {
            raw: './prompts/*.txt',
            resolved: '/base/path/prompts/prompt1.txt',
          },
          {
            raw: './prompts/*.txt',
            resolved: '/base/path/prompts/prompt2.txt',
          },
        ],
      });
    });

    it('should return raw and resolved paths when no files match', () => {
      const promptPathOrGlobs = ['file.js:func'];
      mockedGlobSync.mockReturnValue([]);

      const result = normalizePaths(promptPathOrGlobs, basePath);

      expect(result).toEqual({
        inputType: PromptInputType.ARRAY,
        forceLoadFromFile: new Set(),
        resolvedPathToDisplay: new Map([['/base/path/file.js:func', 'file.js:func']]),
        promptPathInfos: [{ raw: 'file.js:func', resolved: '/base/path/file.js:func' }],
      });
    });

    it('should throw an error for unsupported prompt path type', () => {
      const unsupportedInput = 123 as any; // Intentionally using an unsupported type

      expect(() => normalizePaths(unsupportedInput, basePath)).toThrow(
        `Unsupported prompt path type: ${JSON.stringify(unsupportedInput)}`,
      );
    });
  });

  describe('readProviderPromptMap', () => {
    const samplePrompts: Prompt[] = [
      { raw: 'Raw content for Prompt 1', label: 'Prompt 1' },
      { raw: 'Raw content for Prompt 2', label: 'Prompt 2' },
    ];

    it('should return an empty map if config.providers is undefined', () => {
      const config: Partial<UnifiedConfig> = {};
      const result = readProviderPromptMap(config, samplePrompts);
      expect(result).toEqual({});
    });

    it('should return a map with provider string as key', () => {
      const config: Partial<UnifiedConfig> = { providers: 'provider1' };
      const result = readProviderPromptMap(config, samplePrompts);
      expect(result).toEqual({
        provider1: ['Prompt 1', 'Prompt 2'],
      });
    });

    it('should return a map with "Custom function" as key when providers is a function', () => {
      const config = {
        providers: () => Promise.resolve({ data: [] }),
      } as Partial<UnifiedConfig>;
      const result = readProviderPromptMap(config, samplePrompts);
      expect(result).toEqual({
        'Custom function': ['Prompt 1', 'Prompt 2'],
      });
    });

    it('should return a map with provider objects as keys', () => {
      const config: Partial<UnifiedConfig> = {
        providers: [{ id: 'provider1', prompts: ['Custom Prompt 1'] }, { id: 'provider2' }],
      };
      const result = readProviderPromptMap(config, samplePrompts);
      expect(result).toEqual({
        provider1: ['Custom Prompt 1'],
        provider2: ['Prompt 1', 'Prompt 2'],
      });
    });

    it('should return a map with provider label if it exists', () => {
      const config: Partial<UnifiedConfig> = {
        providers: [{ id: 'provider1', label: 'label1', prompts: ['Custom Prompt 1'] }],
      };
      const result = readProviderPromptMap(config, samplePrompts);
      expect(result).toEqual({
        provider1: ['Custom Prompt 1'],
        label1: ['Custom Prompt 1'],
      });
    });

    it('should return a map with ProviderOptionsMap', () => {
      const config: Partial<UnifiedConfig> = {
        providers: [
          {
            provider1: { id: 'provider1', prompts: ['Custom Prompt 1'] },
          },
        ],
      };
      const result = readProviderPromptMap(config, samplePrompts);
      expect(result).toEqual({
        provider1: ['Custom Prompt 1'],
      });
    });

    it('should use allPrompts if provider prompts are not defined', () => {
      const config: Partial<UnifiedConfig> = {
        providers: [
          { id: 'provider1' },
          {
            provider2: { id: 'provider2' },
          },
        ],
      };
      const result = readProviderPromptMap(config, samplePrompts);
      expect(result).toEqual({
        provider1: ['Prompt 1', 'Prompt 2'],
        provider2: ['Prompt 1', 'Prompt 2'],
      });
    });
  });

  describe('maybeFilepath', () => {
    it('should return true for valid file paths', () => {
      expect(maybeFilepath('path/to/file.txt')).toBe(true);
      expect(maybeFilepath('C:\\path\\to\\file.txt')).toBe(true);
      expect(maybeFilepath('file.*')).toBe(true);
      expect(maybeFilepath('filename.ext')).toBe(true);
    });

    it('should return false for strings with new lines', () => {
      expect(maybeFilepath('path/to\nfile.txt')).toBe(false);
    });

    it('should return false for strings with "portkey://"', () => {
      expect(maybeFilepath('portkey://path/to/file.txt')).toBe(false);
    });

    it('should return false for strings with "langfuse://"', () => {
      expect(maybeFilepath('langfuse://path/to/file.txt')).toBe(false);
    });

    it('should return false for strings without file path indicators', () => {
      expect(maybeFilepath('justastring')).toBe(false);
      expect(maybeFilepath('anotherstring')).toBe(false);
      expect(maybeFilepath('stringwith.dotbutnotfile')).toBe(false);
    });

    it('should return true for strings with wildcard character', () => {
      expect(maybeFilepath('*.txt')).toBe(true);
      expect(maybeFilepath('path/to/*.txt')).toBe(true);
    });

    it('should return true for strings with file extension at the third or fourth last position', () => {
      expect(maybeFilepath('filename.e')).toBe(false);
      expect(maybeFilepath('file.ext')).toBe(true);
      expect(maybeFilepath('filename.ex')).toBe(true);
      expect(maybeFilepath('file.name.ext')).toBe(true);
    });
  });
});
