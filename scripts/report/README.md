# Final report generator

Builds `BCSE408L_Final_Project_Report.docx` in the prescribed template format
(Submission Information table, sections 1–21, Project Access Details, the
submission checklist and the declaration).

All URLs, credentials and the slot live in `report-config.json`, so the report
is regenerated from the same prose whenever the deployment changes:

```bash
cd scripts/report
npm i docx                      # once
node build-final-report.cjs ../../docs/BCSE408L_Final_Project_Report.docx
soffice --headless --convert-to pdf --outdir ../../docs \
        ../../docs/BCSE408L_Final_Project_Report.docx
```

The build prints `STILL PENDING:` and names any field left as a placeholder,
so an unfinished value cannot reach a submission unnoticed.

Diagrams are rendered separately from the Mermaid sources in `docs/diagrams/`.
