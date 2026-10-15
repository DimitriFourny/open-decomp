export const ENCODINGS = [
    {
        "instructionId": "GCSPOPM_SYSL",
        "encodingId": "GCSPOPM_SYSL_RC_systeminstrs",
        "mnemonic": "SYSL",
        "className": "System",
        "fileName": "gcspopm_sysl.xml",
        "mask": 4294967264,
        "value": 3576395552,
        "bitCount": 27,
        "fields": [
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "op1",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "CRn",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_GCS"
        ],
        "featureGuards": [],
        "guards": [],
        "canonicalEncodingId": "SYSL_RC_systeminstrs",
        "canonicalFileName": "sysl.xml",
        "operandFamilyId": "gcs-sysl-alias"
    }
];
