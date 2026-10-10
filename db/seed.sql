-- Sample designers for local testing. Safe to re-run.
-- Replace with Nikhil's real designer list and areas before launch.
insert into designers (name, areas, calendly_link)
select * from (values
  ('Ananya Kulkarni', array['kothrud', 'karve nagar', 'warje', 'bavdhan'],   'https://calendly.com/aangan-ananya/site-visit'),
  ('Rohan Joshi',     array['baner', 'aundh', 'wakad', 'hinjewadi', 'balewadi'], 'https://calendly.com/aangan-rohan/site-visit'),
  ('Meera Patil',     array['kharadi', 'viman nagar', 'koregaon park', 'hadapsar'], 'https://calendly.com/aangan-meera/site-visit')
) as v(name, areas, calendly_link)
where not exists (select 1 from designers d where d.name = v.name);
