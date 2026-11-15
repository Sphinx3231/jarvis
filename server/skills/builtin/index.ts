import type { SkillRegistry } from '../registry.ts';
import { filesList, filesRead, filesSearch, filesWrite } from './files.ts';
import { memoryForget, memoryRemember, memorySearch } from './memory.ts';
import { llmGenerate } from './model.ts';
import { shellRun } from './shell.ts';
import { securityOperate, securityToolkit } from './security.ts';
import { notifyUser, systemStatus, tasksList } from './system.ts';
import { webFetch } from './web.ts';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  for (const skill of [memorySearch, memoryRemember, memoryForget, systemStatus, tasksList, notifyUser, llmGenerate, filesList, filesRead, filesSearch, filesWrite, webFetch, shellRun, securityToolkit, securityOperate]) {
    registry.register(skill);
  }
}
