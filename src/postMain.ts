import { post } from './post';

// Entry of the post bundle (dist/post/index.js), kept apart from the main bundle so a post stage that gets no
// state can only do nothing.
void post();
