import { createContext, useContext } from 'react';
export const LocalMemoryContext = createContext(null);
export const useLocalMemory = () => useContext(LocalMemoryContext);
