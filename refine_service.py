import logging
import re

class RefineService:
    def __init__(self, max_history=10):
        self.history = []
        self.max_history = max_history
        logging.basicConfig(level=logging.INFO)

    def clean_text(self, text):
        """Clean and normalize text for better refinement."""
        text = text.strip()
        text = re.sub(r'\s+', ' ', text)  # normalize whitespace
        text = text.capitalize()  # ensure sentence starts with capital
        if not text.endswith(('.', '!', '?')):
            text += '.'  # ensure proper sentence ending
        return text

    def get_context(self):
        """Get relevant context from history."""
        if not self.history:
            return ""
        # Join last 3 entries as context, if available
        context = " ".join(self.history[-3:])
        return context

    def refine(self, text):
        """Refine text using context and cleaning."""
        text = self.clean_text(text)
        context = self.get_context()
        
        if context:
            # Check for redundancy with context
            if text in context:
                return text  # avoid duplication
            
            # Check if text continues previous sentence
            if context.endswith('...') or not context.endswith(('.', '!', '?')):
                # This might be a continuation
                combined = f"{context} {text}"
                return self.clean_text(combined)
            
            # Add contextual marker if it's a new thought
            if not any(text.lower().startswith(word) for word in ['however', 'but', 'and', 'also', 'additionally']):
                text = f"Additionally, {text}"
        
        return text

    def run(self, refine_queue, audio_queue):
        logging.info("[RefineService] Started refinement service.")
        while True:
            data = refine_queue.get()
            if data is None:
                # If None is passed, we can stop the service gracefully
                break
            
            outputs = data["llm_output"]
            eos = data["eos"]
            refined_outputs = []
            
            for out in outputs:
                refined = self.refine(out)
                self.history.append(refined)
                if len(self.history) > self.max_history:
                    self.history.pop(0)
                refined_outputs.append(refined)
                logging.info(f"[RefineService] Refined output: {refined}")

            # Send to audio_queue for TTS
            audio_queue.put({"llm_output": refined_outputs, "eos": eos})