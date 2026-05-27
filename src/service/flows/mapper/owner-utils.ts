export function deriveOwnerFromAction(action: string): 'BAP' | 'BPP' {
    return action.startsWith('on_') ? 'BPP' : 'BAP';
}
