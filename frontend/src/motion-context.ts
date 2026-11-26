import { createContext, useContext } from "react";
export const MotionPreference = createContext({
  reduced: false,
  toggle: () => {},
});
export const useAppReducedMotion = () => useContext(MotionPreference).reduced;
